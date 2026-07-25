from __future__ import annotations

import contextlib
import io
import json
import struct
import sys
import tempfile
import unittest
from pathlib import Path


SCANNER_DIR = Path(__file__).resolve().parents[1]
if str(SCANNER_DIR) not in sys.path:
    sys.path.insert(0, str(SCANNER_DIR))

import colmap_audit  # noqa: E402
import room_scan  # noqa: E402


class SparseAuditTests(unittest.TestCase):
    @staticmethod
    def make_project(root: Path, frame_count: int) -> Path:
        project = root / "project"
        images = project / "images"
        images.mkdir(parents=True)
        for number in range(1, frame_count + 1):
            (images / f"frame_{number:06d}.jpg").write_bytes(b"image")
        return project

    @staticmethod
    def write_binary_model(
        model: Path,
        image_numbers: list[int],
        points: list[tuple[float, int]],
    ) -> None:
        model.mkdir(parents=True)
        (model / "cameras.bin").write_bytes(struct.pack("<Q", 1))
        image_data = bytearray(struct.pack("<Q", len(image_numbers)))
        for image_id, frame_number in enumerate(image_numbers, 1):
            image_data.extend(struct.pack(
                "<i7dI", image_id, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1
            ))
            image_data.extend(f"frame_{frame_number:06d}.jpg".encode("utf-8") + b"\0")
            image_data.extend(struct.pack("<Q", 0))
        (model / "images.bin").write_bytes(image_data)

        point_data = bytearray(struct.pack("<Q", len(points)))
        for point_id, (error, track_length) in enumerate(points, 1):
            point_data.extend(struct.pack(
                "<Q3d3BdQ",
                point_id,
                0.0,
                0.0,
                0.0,
                255,
                255,
                255,
                error,
                track_length,
            ))
            for observation in range(track_length):
                point_data.extend(struct.pack("<II", observation + 1, 0))
        (model / "points3D.bin").write_bytes(point_data)

    def test_binary_model_reports_all_required_statistics_and_passes(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project = self.make_project(Path(temp_dir), 10)
            model = project / "sparse" / "0"
            self.write_binary_model(
                model,
                [1, 2, 3, 4, 5, 7, 8, 9, 10],
                [(1.0, 3), (1.4, 5)],
            )
            report = colmap_audit.audit_sparse_project(project)
        audited = report.selected
        self.assertEqual(report.total_frames, 10)
        self.assertEqual(audited.registered_images, 9)
        self.assertAlmostEqual(audited.registration_ratio, 0.9)
        self.assertEqual(audited.point_count, 2)
        self.assertEqual(audited.observation_count, 8)
        self.assertAlmostEqual(audited.average_track_length or 0, 4.0)
        self.assertAlmostEqual(audited.mean_reprojection_error_px or 0, 1.2)
        self.assertEqual(audited.max_unregistered_gap.count, 1)
        self.assertEqual(audited.max_unregistered_gap.start, "frame_000006.jpg")
        self.assertTrue(report.passes)
        self.assertTrue(json.loads(report.to_json())["passes"])

    def test_fragmented_models_are_not_summed_for_quality_gate(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project = self.make_project(Path(temp_dir), 10)
            self.write_binary_model(
                project / "sparse" / "0", list(range(1, 7)), [(0.5, 4)]
            )
            self.write_binary_model(
                project / "sparse" / "1", list(range(7, 11)), [(0.5, 4)]
            )
            report = colmap_audit.audit_sparse_project(project)
        self.assertEqual(report.unique_registered_images, 10)
        self.assertEqual(report.unique_registration_ratio, 1.0)
        self.assertEqual(report.selected.registered_images, 6)
        self.assertFalse(report.selected.passes_registration)
        self.assertFalse(report.passes)

    def test_text_model_and_empty_points2d_lines_are_supported(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project = self.make_project(Path(temp_dir), 3)
            model = project / "sparse" / "0"
            model.mkdir(parents=True)
            (model / "cameras.txt").write_text("# camera\n", encoding="utf-8")
            (model / "images.txt").write_text(
                "# images\n"
                "1 1 0 0 0 0 0 0 1 frame_000001.jpg\n\n"
                "2 1 0 0 0 0 0 0 1 frame_000002.jpg\n\n"
                "3 1 0 0 0 0 0 0 1 frame_000003.jpg\n\n",
                encoding="utf-8",
            )
            (model / "points3D.txt").write_text(
                "# points\n"
                "1 0 0 0 255 255 255 0.75 1 0 2 0 3 0\n",
                encoding="utf-8",
            )
            report = colmap_audit.audit_sparse_project(project)
        self.assertEqual(report.selected.registered_images, 3)
        self.assertEqual(report.selected.observation_count, 3)
        self.assertEqual(report.selected.average_track_length, 3.0)
        self.assertEqual(report.selected.max_unregistered_gap.count, 0)
        self.assertTrue(report.passes)

    def test_gap_includes_unregistered_tail(self) -> None:
        gap = colmap_audit.longest_unregistered_gap(
            [f"frame_{number:06d}.jpg" for number in range(1, 11)],
            [f"frame_{number:06d}.jpg" for number in range(1, 6)],
        )
        self.assertEqual(gap.count, 5)
        self.assertEqual(gap.start, "frame_000006.jpg")
        self.assertEqual(gap.end, "frame_000010.jpg")

    def test_truncated_binary_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            project = self.make_project(Path(temp_dir), 1)
            model = project / "sparse" / "0"
            model.mkdir(parents=True)
            (model / "cameras.bin").write_bytes(b"camera")
            (model / "images.bin").write_bytes(struct.pack("<Q", 1) + b"short")
            (model / "points3D.bin").write_bytes(struct.pack("<Q", 0))
            with self.assertRaises(colmap_audit.SparseAuditError):
                colmap_audit.audit_sparse_project(project)

    def test_room_scan_cli_emits_json_and_uses_gate_exit_code(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            dataset_root = Path(temp_dir) / "datasets"
            project = self.make_project(dataset_root, 10)
            self.write_binary_model(
                project / "sparse" / "0", list(range(1, 7)), [(0.5, 4)]
            )
            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                code = room_scan.main([
                    "audit-sparse",
                    "project",
                    "--dataset-root",
                    str(dataset_root),
                    "--json",
                ])
        payload = json.loads(stdout.getvalue())
        self.assertEqual(code, 3)
        self.assertEqual(payload["total_frames"], 10)
        self.assertFalse(payload["passes"])


if __name__ == "__main__":
    unittest.main()
