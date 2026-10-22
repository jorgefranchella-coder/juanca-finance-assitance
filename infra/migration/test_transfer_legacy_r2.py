import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from transfer_legacy_r2 import plan, recover_zero_size_item


class LegacyR2TransferTests(unittest.TestCase):
    def setUp(self):
        self.content = b'synthetic source document'
        self.digest = hashlib.sha256(self.content).hexdigest()
        self.imports = [{
            'id': 'source-id', 'owner': 'Julia', 'file_type': 'positions',
            'file_name': 'positions.xlsx', 'sha256': self.digest,
            'object_key': 'legacy/private/source-id.xlsx', 'reference_date': '2026-10-19',
        }]
        self.objects = [{
            'key': 'legacy/private/source-id.xlsx', 'size': len(self.content),
            'custom_metadata': json.dumps({'sha256': self.digest}),
            'http_metadata': json.dumps({'contentType': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'}),
        }]

    def test_plan_preserves_historical_owner_type_date_and_hash(self):
        item = plan(self.imports, self.objects)[0]
        self.assertEqual((item['owner'], item['source'], item['file_type'], item['reference_date']),
                         ('Julia', 'b3', 'positions', '2026-10-19'))
        self.assertEqual(item['owner_ref'], 'owner-e89fe62ec86347c2b50f4a87')
        self.assertEqual(item['content_sha256'], self.digest)

    def test_plan_rejects_missing_or_unreferenced_objects(self):
        with self.assertRaisesRegex(ValueError, 'do not match exactly'):
            plan(self.imports, [])

    def test_plan_rejects_mismatched_source_hash(self):
        bad = [dict(self.objects[0], custom_metadata=json.dumps({'sha256': '0' * 64}))]
        with self.assertRaisesRegex(ValueError, 'hashes differ'):
            plan(self.imports, bad)

    def test_empty_r2_blob_requires_an_existing_hash_verified_recovery_copy(self):
        item = plan(self.imports, [dict(self.objects[0], size=0)])[0]
        with tempfile.TemporaryDirectory() as root:
            object_root = Path(root)
            target = object_root / 'objects' / self.digest[:2] / self.digest
            target.parent.mkdir(parents=True)
            target.write_bytes(self.content)
            recover_zero_size_item(item, object_root)
            self.assertEqual(item['byte_size'], len(self.content))
            self.assertEqual(item['recovery_source'], 'verified_existing_shadow_copy')
            target.write_bytes(b'corrupt')
            item['byte_size'] = 0
            with self.assertRaisesRegex(ValueError, 'does not match'):
                recover_zero_size_item(item, object_root)


if __name__ == '__main__':
    unittest.main()
