import os
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
import document_fetch as d

UNIT = 'juanca-document-pdf.service'

class ProcessLimits(unittest.TestCase):
    def test_missing_bus_or_launcher_fails_closed(self):
        with patch.object(d.subprocess, 'Popen', side_effect=FileNotFoundError):
            with self.assertRaises(d.FetchError) as e:
                d.read_pdf(b'%PDF-synthetic', time.monotonic()+2)
        self.assertEqual(e.exception.code, 'tool_unavailable')

    def test_invalid_pdf_and_busy_have_distinct_codes(self):
        with self.assertRaises(d.FetchError) as e:
            d.read_pdf(b'%PDF-invalid', time.monotonic()+5)
        self.assertEqual(e.exception.code, 'unsupported_format')
        with patch.object(d, 'download', side_effect=d.FetchError('busy')):
            result = d.retrieve('https://synthetic.test/')
        self.assertEqual(result['code'], 'busy')
        self.assertIn('vuelve a intentarlo', result['next_step'])

    def test_capture_sets_deadline_and_closes_pipe(self):
        p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'], stdout=subprocess.PIPE, start_new_session=True)
        start = time.monotonic()
        with self.assertRaises(d.FetchError) as e: d._capture_process(p, start+.25)
        self.assertEqual(e.exception.code, 'timeout')
        self.assertLess(time.monotonic()-start, .8)
        self.assertTrue(p.stdout.closed)
        p.wait(timeout=2)

    def fixture(self, directory):
        shutil.copy(d.__file__, directory+'/document_fetch.py')
        with open(os.path.join(os.path.dirname(d.__file__), 'pdf_sandbox_runner.py')) as f:
            runner = f.read()
        a = runner.index('    command = ')
        b = runner.index('    process = ', a)
        # Fork a setsid child retaining stdout and run until the service is stopped.
        code = 'import os,time\np=os.fork()\nif not p: os.setsid(); time.sleep(30); os._exit(0)\ntime.sleep(30)'
        runner = runner[:a] + "    command = ['/usr/bin/bwrap','--unshare-user','--unshare-pid','--unshare-net','--die-with-parent','--clearenv','--ro-bind','/usr','/usr','--ro-bind','/lib','/lib','--ro-bind','/lib64','/lib64','--proc','/proc','--dev','/dev','/usr/bin/python3','-c',%r]\n" % code + runner[b:]
        with open(directory+'/pdf_sandbox_runner.py','w') as f: f.write(runner)

    def start_client(self, directory, deadline=10, size=14):
        code = 'import document_fetch as d,time\ntry: d.read_pdf(b"x"*%s,time.monotonic()+%s)\nexcept d.FetchError as e: print(e.code)' % (size, deadline)
        return subprocess.Popen([sys.executable,'-c',code], cwd=directory, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    def wait_active(self):
        end=time.monotonic()+3
        while time.monotonic()<end:
            r=subprocess.run(['systemctl','--user','is-active',UNIT],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            if r.returncode==0: return
            time.sleep(.02)
        self.fail('synthetic service did not start')

    def wait_inactive(self):
        end=time.monotonic()+4
        while time.monotonic()<end:
            r=subprocess.run(['systemctl','--user','show',UNIT,'--property=LoadState','--value'],capture_output=True,text=True)
            if r.stdout.strip() == 'not-found': return
            time.sleep(.03)
        self.fail('synthetic service not cleaned up')

    def test_two_process_quota_and_client_death_cleanup(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.fixture(tmp)
            first=self.start_client(tmp)
            try:
                self.wait_active()
                second=self.start_client(tmp, size=1000000)
                out,err=second.communicate(timeout=3)
                self.assertEqual(out.strip(), b'busy', err)
                self.assertIsNone(first.poll())
                first.kill(); first.communicate(timeout=2)
                self.wait_inactive()
                # A new independent client is admitted after cleanup.
                third=self.start_client(tmp, .4)
                out,err=third.communicate(timeout=3)
                self.assertEqual(out.strip(),b'timeout',err)
                self.wait_inactive()
            finally:
                if first.poll() is None: first.kill(); first.communicate()

    def test_timeout_stops_service_with_setsid_child(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.fixture(tmp)
            p=self.start_client(tmp, .5)
            out,err=p.communicate(timeout=3)
            self.assertEqual(out.strip(), b'timeout',err)
            self.wait_inactive()
