import os
import signal
import subprocess
import sys
import threading
import tempfile
import time
import unittest
from unittest.mock import patch
import document_fetch as d

class DNSProcessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.lock_path = self.temp.name + '/juanca-document-dns'
        patcher = patch.dict(d.os.environ, {'JUANCA_DNS_RUNTIME_DIR': self.temp.name})
        patcher.start()
        self.addCleanup(patcher.stop)


    def test_runtime_directory_prefers_juanca_setting(self):
        self.assertEqual(
            d._dns_runtime_dir({'JUANCA_DNS_RUNTIME_DIR': 'juanca-runtime-fixture', 'XDG_RUNTIME_DIR': 'xdg-runtime-fixture'}),
            'juanca-runtime-fixture',
        )

    def test_runtime_directory_falls_back_to_xdg(self):
        self.assertEqual(d._dns_runtime_dir({'XDG_RUNTIME_DIR': 'xdg-runtime-fixture'}), 'xdg-runtime-fixture')

    def test_runtime_directory_missing_fails_closed(self):
        with patch.dict(d.os.environ, {}, clear=True), patch.object(d.subprocess, 'Popen') as spawn:
            with self.assertRaises(d.FetchError) as error:
                d._dns_lookup('synthetic.test', 443, time.monotonic() + 1)
        self.assertEqual(error.exception.code, 'tool_unavailable')
        spawn.assert_not_called()

    def test_invalid_explicit_runtime_does_not_fall_back_to_xdg(self):
        with patch.dict(d.os.environ, {'JUANCA_DNS_RUNTIME_DIR': 'invalid-runtime-fixture', 'XDG_RUNTIME_DIR': 'valid-runtime-fixture'}, clear=True):
            with patch.object(d.subprocess, 'Popen') as spawn:
                with self.assertRaises(d.FetchError) as error:
                    d._dns_lookup('synthetic.test', 443, time.monotonic() + 1)
        self.assertEqual(error.exception.code, 'tool_unavailable')
        spawn.assert_not_called()

    def test_repeat_timeout_reaps_resolver_without_threads_accumulating(self):
        original = subprocess.Popen
        processes = []
        before = len(threading.enumerate())
        def sleeper(command, **kwargs):
            process = original([sys.executable, '-c', 'import time; time.sleep(30)'], **kwargs)
            processes.append(process)
            return process
        with patch.object(d.subprocess, 'Popen', side_effect=sleeper):
            for _ in range(8):
                with self.assertRaises(d.FetchError) as e:
                    d.resolve('synthetic.test', 443, time.monotonic()+.07)
                self.assertEqual(e.exception.code, 'timeout')
                # Wait for the kernel to reap the killed synthetic process.
                processes[-1].wait(timeout=2)
        end = time.monotonic()+2
        while len(threading.enumerate()) > before and time.monotonic() < end:
            time.sleep(.01)
        self.assertTrue(all(p.poll() is not None for p in processes))
        self.assertLessEqual(len(threading.enumerate()), before)

    def test_cross_process_dns_busy_and_recovery(self):
        lockdir = self.lock_path
        os.makedirs(lockdir, mode=0o700, exist_ok=True)
        code = ('import fcntl,sys,time,os\nf=open(sys.argv[1],"a+"); os.fchmod(f.fileno(),0o600)\n'
                'fcntl.flock(f,fcntl.LOCK_EX)\nprint("ready",flush=True)\ntime.sleep(30)')
        p = subprocess.Popen([sys.executable,'-c',code,lockdir+'/dns.lock'],stdout=subprocess.PIPE,text=True)
        try:
            self.assertEqual(p.stdout.readline().strip(), 'ready')
            with self.assertRaises(d.FetchError) as e: d.resolve('synthetic.test',443,time.monotonic()+1)
            self.assertEqual(e.exception.code, 'busy')
        finally:
            p.kill(); p.communicate(timeout=2)
        # Use a short-lived synthetic child, never a network lookup.
        actual = subprocess.Popen
        with patch.object(d.subprocess, 'Popen', side_effect=lambda cmd, **kw: actual([sys.executable,'-c',"print('[\"8.8.8.8\",\"1.1.1.1\"]')"], **kw)):
            self.assertEqual(d.resolve('synthetic.test',443,time.monotonic()+2), ['1.1.1.1','8.8.8.8'])

    def synthetic_resolver(self):
        with open(d.DNS_RESOLVER) as f:
            source = f.read()
        marker = self.temp.name + '/resolver.pid'
        fake = ("def fake_lookup(host, port, type=None):\n"
                "    if host == 'blocked.test':\n"
                "        open(%r, 'w').write(str(os.getpid()))\n"
                "        time.sleep(30)\n"
                "    return [(2, 1, 6, '', ('8.8.8.8', port))]\n\n" % marker)
        source = source.replace('def main():', fake + 'def main():')
        source = source.replace('answers = socket.getaddrinfo(', 'answers = fake_lookup(')
        path = self.temp.name + '/dns_resolver.py'
        with open(path, 'w') as f:
            f.write(source)
        return path, marker

    def test_resolver_autoterminates_on_deadline(self):
        script, marker = self.synthetic_resolver()
        p = subprocess.Popen([sys.executable, '-I', script, 'blocked.test', '443',
                              str(time.monotonic()+.3), str(os.getpid())], stdout=subprocess.PIPE)
        try:
            p.communicate(timeout=3)
            self.assertEqual(p.returncode, -signal.SIGALRM)
            self.assertTrue(os.path.exists(marker))
        finally:
            if p.poll() is None: p.kill(); p.communicate()

    def test_sigkill_client_cleans_blocked_resolver_and_releases_quota(self):
        script, marker = self.synthetic_resolver()
        # The two clients share only the synthetic runtime and resolver fixture.
        code = ("import document_fetch as d,time,sys,os\n"
                "os.environ['JUANCA_DNS_RUNTIME_DIR']=sys.argv[1];d.DNS_RESOLVER=sys.argv[2]\n"
                "print(d.resolve(sys.argv[3],443,time.monotonic()+10),flush=True)")
        client = subprocess.Popen([sys.executable, '-c', code, self.temp.name, script, 'blocked.test'],
                                  cwd=os.path.dirname(d.__file__), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            end = time.monotonic()+3
            while not os.path.exists(marker) and time.monotonic()<end: time.sleep(.01)
            self.assertTrue(os.path.exists(marker))
            with open(marker) as f: resolver_pid = int(f.read())
            client.kill(); client.communicate(timeout=2)
            end=time.monotonic()+3
            while time.monotonic()<end:
                try:
                    with open('/proc/%d/stat' % resolver_pid) as f: state=f.read().split(') ')[1][0]
                except FileNotFoundError:
                    break
                if state == 'Z': break
                time.sleep(.01)
            else: self.fail('resolver survived client SIGKILL')
            next_client=subprocess.run([sys.executable, '-c', code, self.temp.name, script, 'ok.test'],
                                       cwd=os.path.dirname(d.__file__),capture_output=True,text=True,timeout=3)
            self.assertEqual(next_client.returncode, 0, next_client.stderr)
            self.assertIn('8.8.8.8', next_client.stdout)
        finally:
            if client.poll() is None: client.kill(); client.communicate()

    def test_insecure_runtime_and_foreign_uid_fail_closed(self):
        with patch.dict(d.os.environ, {'JUANCA_DNS_RUNTIME_DIR': tempfile.gettempdir()}):
            with self.assertRaises(d.FetchError) as e: d.resolve('synthetic.test',443,time.monotonic()+1)
            self.assertEqual(e.exception.code,'tool_unavailable')
        # Simulates a runtime precreated by a different UID without requiring root.
        with patch.object(d.os, 'getuid', return_value=os.getuid()+1):
            with self.assertRaises(d.FetchError) as e: d.resolve('synthetic.test',443,time.monotonic()+1)
            self.assertEqual(e.exception.code,'tool_unavailable')
        os.chmod(self.temp.name, 0o755)
        with self.assertRaises(d.FetchError) as e: d.resolve('synthetic.test',443,time.monotonic()+1)
        self.assertEqual(e.exception.code,'tool_unavailable')
        os.chmod(self.temp.name, 0o700)

    def test_symlinks_and_hardlinks_fail_closed(self):
        os.symlink(self.temp.name, self.temp.name + '-link')
        try:
            with patch.dict(d.os.environ, {'JUANCA_DNS_RUNTIME_DIR': self.temp.name + '-link'}):
                with self.assertRaises(d.FetchError) as e: d.resolve('synthetic.test',443,time.monotonic()+1)
                self.assertEqual(e.exception.code,'tool_unavailable')
        finally:
            os.unlink(self.temp.name + '-link')
        os.symlink('/tmp',self.lock_path)
        with self.assertRaises(d.FetchError) as e: d.resolve('synthetic.test',443,time.monotonic()+1)
        self.assertEqual(e.exception.code,'tool_unavailable')
        os.unlink(self.lock_path); os.mkdir(self.lock_path, 0o700)
        os.symlink(os.devnull, self.lock_path+'/dns.lock')
        with self.assertRaises(d.FetchError) as e: d.resolve('synthetic.test',443,time.monotonic()+1)
        self.assertEqual(e.exception.code,'tool_unavailable')
        os.unlink(self.lock_path+'/dns.lock')
        with open(self.lock_path+'/dns.lock','w') as f: pass
        os.chmod(self.lock_path+'/dns.lock',0o644)
        with self.assertRaises(d.FetchError) as e: d.resolve('synthetic.test',443,time.monotonic()+1)
        self.assertEqual(e.exception.code,'tool_unavailable')
        os.unlink(self.lock_path+'/dns.lock')
        with open(self.temp.name+'/other','w') as f: pass
        os.chmod(self.temp.name+'/other',0o600)
        os.link(self.temp.name+'/other',self.lock_path+'/dns.lock')
        with self.assertRaises(d.FetchError) as e: d.resolve('synthetic.test',443,time.monotonic()+1)
        self.assertEqual(e.exception.code,'tool_unavailable')

    def test_rejects_all_results_when_one_address_is_private(self):
        for address in ['127.0.0.1','10.0.0.1','::1','::ffff:8.8.8.8']:
            with patch.object(d, '_dns_lookup', return_value=['8.8.8.8',address]):
                with self.assertRaises(d.FetchError) as e: d.resolve('synthetic.test',443,time.monotonic()+1)
                self.assertEqual(e.exception.code,'unsafe_destination')
