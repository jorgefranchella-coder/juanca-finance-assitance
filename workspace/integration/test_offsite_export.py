import hashlib
import io
import unittest

from offsite_export import hash_stream, require_upload_authorized, validate_remote


class OffsiteExportTests(unittest.TestCase):
    def test_upload_requires_explicit_offline_key_confirmation(self):
        with self.assertRaisesRegex(ValueError, 'stored offline'):
            require_upload_authorized(True, {'JUANCA_OFFSITE_REMOTE': 'pcloud:juanca'})

    def test_upload_requires_configured_remote_and_folder(self):
        env = {'JUANCA_OFFSITE_KEY_STORED_OFFLINE': '1', 'JUANCA_OFFSITE_REMOTE': 'pcloud:'}
        with self.assertRaisesRegex(ValueError, 'destination folder'):
            require_upload_authorized(True, env)

    def test_local_prepare_does_not_need_upload_confirmation(self):
        self.assertIsNone(require_upload_authorized(False, {}))

    def test_remote_must_be_configured_and_cannot_traverse(self):
        validate_remote('pcloud:backups/juanca', {'pcloud'})
        with self.assertRaisesRegex(ValueError, 'configured rclone'):
            validate_remote('unknown:backups', {'pcloud'})
        with self.assertRaisesRegex(ValueError, 'traverse'):
            validate_remote('pcloud:backups/../other', {'pcloud'})

    def test_hash_stream_is_incremental_and_reports_size(self):
        payload = b'x' * (1024 * 1024 + 7)
        digest, size = hash_stream(io.BytesIO(payload))
        self.assertEqual(digest, hashlib.sha256(payload).hexdigest())
        self.assertEqual(size, len(payload))


if __name__ == '__main__':
    unittest.main()
