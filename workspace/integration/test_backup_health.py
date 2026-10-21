"""Exercise freshness checks using synthetic backup manifests only."""
from datetime import datetime, timezone, timedelta
import json
from pathlib import Path
import tempfile
import unittest

from backup_health import latest_check


class BackupHealthTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.now = datetime(2026, 10, 22, 8, tzinfo=timezone.utc)

    def tearDown(self):
        self.temp.cleanup()

    def backup(self, name, created):
        path = self.root / name
        path.mkdir()
        (path / 'manifest.json').write_text(json.dumps({'created_at': created.isoformat()}))
        return path

    def test_accepts_latest_fresh_backup_after_verifying_it(self):
        latest = self.backup('backup-20261022T073000Z', self.now - timedelta(minutes=30))
        verified = []
        result = latest_check(self.root, 'backup-', verified.append, self.now, 32)
        self.assertEqual(verified, [latest])
        self.assertTrue(result['verified'])
        self.assertEqual(result['age_hours'], 0.5)

    def test_rejects_stale_latest_even_if_older_backup_exists(self):
        old = self.backup('backup-20261020T080000Z', self.now - timedelta(days=2))
        newest = self.backup('backup-20261020T090000Z', self.now - timedelta(days=2) + timedelta(hours=1))
        with self.assertRaisesRegex(ValueError, 'stale'):
            latest_check(self.root, 'backup-', lambda _: None, self.now, 32)

    def test_rejects_future_timestamp_and_empty_backup_root(self):
        self.backup('backup-20261023T080000Z', self.now + timedelta(hours=1))
        with self.assertRaisesRegex(ValueError, 'future'):
            latest_check(self.root, 'backup-', lambda _: None, self.now, 32)
        with tempfile.TemporaryDirectory() as empty:
            with self.assertRaisesRegex(ValueError, 'No backup'):
                latest_check(Path(empty), 'backup-', lambda _: None, self.now, 32)


if __name__ == '__main__':
    unittest.main()
