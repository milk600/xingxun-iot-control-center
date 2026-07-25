from __future__ import annotations

import contextlib
import io
import json
import struct
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


SCANNER_DIR = Path(__file__).resolve().parents[1]
if str(SCANNER_DIR) not in sys.path:
    sys.path.insert(0, str(SCANNER_DIR))

import room_scan  # noqa: E402


class PathSafetyTests(unittest.TestCase):
    def test_rejects_traversal_and_windows_reserved_names(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            for name in ("..", "../escape", "room/escape", "CON", "bad:name"):
                with self.subTest(name=name):
                    with self.assertRaises(room_scan.RoomScanError):
                        room_scan.dataset_paths(temp_dir, name)

    def test_project_and_outputs_stay_under_dataset_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = room_scan.dataset_paths(temp_dir, "room-01")
            self.assertEqual(paths.project.parent, Path(temp_dir).resolve())
            paths.images.relative_to(paths.project)
            paths.sparse.relative_to(paths.project)
            paths.brush_output.relative_to(paths.project)
            cpu_paths = room_scan.cpu_reconstruction_paths(paths, "room-01")
            cpu_paths.output.relative_to(paths.project)
            cpu_paths.embedded_glb.relative_to(paths.project)

    def test_next_frame_index_ignores_unrelated_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            images = Path(temp_dir)
            (images / "frame_000003.jpg").touch()
            (images / "frame_000012.JPG").touch()
            (images / "notes.jpg").touch()
            self.assertEqual(room_scan.next_frame_index(images), 13)


class CommandConstructionTests(unittest.TestCase):
    def test_colmap_batch_is_resolved_without_executing_a_shell(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            launcher = root / "COLMAP.bat"
            executable = root / "bin" / "colmap.exe"
            plugins = root / "lib" / "plugins"
            executable.parent.mkdir()
            plugins.mkdir(parents=True)
            launcher.touch()
            executable.touch()
            result = room_scan.locate_colmap(str(launcher))
            self.assertEqual(result.executable, str(executable.resolve()))
            env = room_scan.colmap_runtime_environment(result.executable or "")
            self.assertEqual(env["QT_PLUGIN_PATH"], str(plugins))
            self.assertTrue(env["PATH"].startswith(str(root / "lib")))

    def test_colmap_command_is_cpu_video_sparse_only(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = room_scan.dataset_paths(temp_dir, "room")
            command = room_scan.build_colmap_command("colmap.exe", paths)
        self.assertEqual(command[0:2], ["colmap.exe", "automatic_reconstructor"])
        pairs = dict(zip(command[2::2], command[3::2]))
        self.assertEqual(pairs["--data_type"], "VIDEO")
        self.assertEqual(pairs["--single_camera"], "1")
        self.assertEqual(pairs["--sparse"], "1")
        self.assertEqual(pairs["--dense"], "0")
        self.assertEqual(pairs["--use_gpu"], "0")

    def test_high_quality_video_commands_use_colmap_41_cpu_options(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = room_scan.dataset_paths(temp_dir, "phone")
            feature, matching, mapper = room_scan.build_colmap_video_commands(
                "colmap.exe",
                paths,
                affine_shape=True,
                domain_size_pooling=True,
            )

        feature_pairs = dict(zip(feature[2::2], feature[3::2]))
        self.assertEqual(feature[0:2], ["colmap.exe", "feature_extractor"])
        self.assertEqual(feature_pairs["--ImageReader.camera_model"], "SIMPLE_RADIAL")
        self.assertEqual(feature_pairs["--ImageReader.single_camera"], "1")
        self.assertEqual(feature_pairs["--FeatureExtraction.type"], "SIFT")
        self.assertEqual(feature_pairs["--FeatureExtraction.use_gpu"], "0")
        self.assertEqual(feature_pairs["--FeatureExtraction.max_image_size"], "3200")
        self.assertEqual(feature_pairs["--SiftExtraction.max_num_features"], "8192")
        self.assertEqual(feature_pairs["--SiftExtraction.estimate_affine_shape"], "1")
        self.assertEqual(feature_pairs["--SiftExtraction.domain_size_pooling"], "1")

        matching_pairs = dict(zip(matching[2::2], matching[3::2]))
        self.assertEqual(matching[0:2], ["colmap.exe", "sequential_matcher"])
        self.assertEqual(matching_pairs["--FeatureMatching.use_gpu"], "0")
        self.assertEqual(matching_pairs["--FeatureMatching.guided_matching"], "1")
        self.assertEqual(matching_pairs["--SiftMatching.cpu_brute_force_matcher"], "1")
        self.assertEqual(matching_pairs["--SequentialMatching.overlap"], "20")
        self.assertEqual(matching_pairs["--SequentialMatching.quadratic_overlap"], "1")
        self.assertEqual(matching_pairs["--SequentialMatching.loop_detection"], "0")
        self.assertNotIn("--FeatureExtraction.num_threads", feature)
        self.assertNotIn("--FeatureMatching.num_threads", matching)
        self.assertNotIn("--SequentialMatching.num_threads", matching)
        self.assertNotIn("--SequentialMatching.vocab_tree_path", matching)

        mapper_pairs = dict(zip(mapper[2::2], mapper[3::2]))
        self.assertEqual(mapper[0:2], ["colmap.exe", "mapper"])
        self.assertEqual(mapper_pairs["--Mapper.ba_use_gpu"], "0")
        self.assertNotIn("--Mapper.num_threads", mapper)
        self.assertEqual(Path(mapper_pairs["--output_path"]).name, "sparse")
        all_arguments = " ".join(part for command in (feature, matching, mapper) for part in command)
        self.assertNotIn("vocab_tree", all_arguments.lower())
        self.assertNotIn("exhaustive_matcher", all_arguments)

    def test_video_commands_add_thread_caps_and_explicit_loop_tree(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            paths = room_scan.dataset_paths(root / "datasets", "phone")
            vocab_tree = root / "local vocab tree.bin"
            vocab_tree.write_bytes(b"vocabulary-tree")
            feature, matching, mapper = room_scan.build_colmap_video_commands(
                "colmap.exe",
                paths,
                max_threads=8,
                loop_detection=True,
                vocab_tree_path=vocab_tree,
            )

            feature_pairs = dict(zip(feature[2::2], feature[3::2]))
            matching_pairs = dict(zip(matching[2::2], matching[3::2]))
            mapper_pairs = dict(zip(mapper[2::2], mapper[3::2]))
            self.assertEqual(feature_pairs["--FeatureExtraction.num_threads"], "8")
            self.assertEqual(matching_pairs["--FeatureMatching.num_threads"], "8")
            self.assertEqual(matching_pairs["--SequentialMatching.num_threads"], "8")
            self.assertEqual(matching_pairs["--SequentialMatching.loop_detection"], "1")
            self.assertEqual(
                matching_pairs["--SequentialMatching.vocab_tree_path"],
                str(vocab_tree.resolve()),
            )
            self.assertEqual(mapper_pairs["--Mapper.num_threads"], "8")

    def test_cpu_reconstruction_commands_match_stable_openmvs_profile(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = room_scan.dataset_paths(temp_dir, "room")
            cpu_paths = room_scan.cpu_reconstruction_paths(paths, "room")
            tools = room_scan.OpenMvsTools(
                "InterfaceCOLMAP.exe",
                "DensifyPointCloud.exe",
                "ReconstructMesh.exe",
                "TextureMesh.exe",
                "test",
            )
            commands = room_scan.build_cpu_reconstruction_commands(
                "colmap.exe",
                tools,
                paths,
                cpu_paths,
                paths.sparse / "2",
                max_resolution=1280,
                min_resolution=320,
                max_threads=8,
            )
        self.assertEqual(commands[0][0:2], ["colmap.exe", "image_undistorter"])
        self.assertIn("--max_image_size", commands[0])
        self.assertEqual(commands[1][1:7], ["-i", "colmap", "-o", "scene_cpu.mvs", "--image-folder", "images"])
        self.assertIn("--geometric-iters", commands[2])
        self.assertIn("--fusion-filter", commands[2])
        self.assertIn("--tower-mode", commands[2])
        self.assertIn("--remove-spurious", commands[3])
        self.assertIn("--decimate", commands[3])
        self.assertIn("--export-type", commands[4])
        self.assertIn("glb", commands[4])
        option = lambda command, name: command[command.index(name) + 1]
        self.assertEqual(option(commands[2], "--resolution-level"), "1")
        self.assertEqual(option(commands[2], "--max-resolution"), "1280")
        self.assertEqual(option(commands[2], "--min-resolution"), "320")
        self.assertEqual(option(commands[2], "--sub-resolution-levels"), "1")
        self.assertEqual(option(commands[2], "--number-views"), "4")
        self.assertEqual(option(commands[2], "--number-views-fuse"), "2")
        self.assertEqual(option(commands[2], "--iters"), "3")
        self.assertEqual(option(commands[2], "--geometric-iters"), "1")
        self.assertEqual(option(commands[2], "--fusion-filter"), "1")
        self.assertEqual(option(commands[3], "--remove-spurious"), "4")
        self.assertEqual(option(commands[3], "--close-holes"), "30")
        self.assertEqual(option(commands[3], "--smooth"), "2")
        self.assertEqual(option(commands[3], "--decimate"), "0.5")
        self.assertEqual(option(commands[3], "-o"), "scene_cpu_mesh.ply")
        self.assertEqual(option(commands[4], "--resolution-level"), "1")
        self.assertEqual(option(commands[4], "--min-resolution"), "320")
        self.assertEqual(option(commands[4], "--max-texture-size"), "4096")

    def test_cpu_reconstruction_high_profile_matches_openmvs_24_options(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = room_scan.dataset_paths(temp_dir, "room")
            cpu_paths = room_scan.cpu_reconstruction_paths(paths, "room")
            tools = room_scan.OpenMvsTools(
                "InterfaceCOLMAP.exe",
                "DensifyPointCloud.exe",
                "ReconstructMesh.exe",
                "TextureMesh.exe",
                "test",
            )
            commands = room_scan.build_cpu_reconstruction_commands(
                "colmap.exe",
                tools,
                paths,
                cpu_paths,
                paths.sparse / "0",
                max_threads=8,
                preset="high",
            )
        option = lambda command, name: command[command.index(name) + 1]
        self.assertEqual(option(commands[0], "--max_image_size"), "1920")
        self.assertEqual(option(commands[2], "--resolution-level"), "0")
        self.assertEqual(option(commands[2], "--max-resolution"), "1920")
        self.assertEqual(option(commands[2], "--min-resolution"), "640")
        self.assertEqual(option(commands[2], "--sub-resolution-levels"), "2")
        self.assertEqual(option(commands[2], "--number-views"), "5")
        self.assertEqual(option(commands[2], "--number-views-fuse"), "2")
        self.assertEqual(option(commands[2], "--iters"), "3")
        self.assertEqual(option(commands[2], "--geometric-iters"), "2")
        self.assertEqual(option(commands[2], "--fusion-filter"), "2")
        self.assertEqual(option(commands[3], "--remove-spurious"), "4")
        self.assertEqual(option(commands[3], "--close-holes"), "15")
        self.assertEqual(option(commands[3], "--smooth"), "1")
        self.assertEqual(option(commands[3], "--decimate"), "1.0")
        self.assertEqual(option(commands[4], "--resolution-level"), "0")
        self.assertEqual(option(commands[4], "--min-resolution"), "640")
        self.assertEqual(option(commands[4], "--max-texture-size"), "8192")

    def test_best_colmap_component_uses_registered_image_count(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            sparse = Path(temp_dir) / "sparse"
            for index, count in ((0, 3), (1, 9)):
                model = sparse / str(index)
                model.mkdir(parents=True)
                (model / "cameras.bin").write_bytes(b"camera")
                (model / "images.bin").write_bytes(struct.pack("<Q", count))
                (model / "points3D.bin").write_bytes(b"points")
            selected, ranked = room_scan.choose_colmap_model(sparse)
            explicit, _ = room_scan.choose_colmap_model(sparse, 0)
        self.assertEqual(selected.name, "1")
        self.assertEqual(ranked[0][1], 9)
        self.assertEqual(explicit.name, "0")

    def test_sparse_quality_gate_uses_best_connected_model(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            sparse = Path(temp_dir) / "sparse"
            for index, count in ((0, 84), (1, 20)):
                model = sparse / str(index)
                model.mkdir(parents=True)
                (model / "cameras.bin").write_bytes(b"camera")
                (model / "images.bin").write_bytes(struct.pack("<Q", count))
                (model / "points3D.bin").write_bytes(b"points")
            report = room_scan.analyze_sparse_quality(sparse, 100, 85.0)
            boundary = room_scan.analyze_sparse_quality(sparse, 100, 84.0)
        self.assertEqual(report.best_model.name, "0")
        self.assertEqual(report.best_registered, 84)
        self.assertAlmostEqual(report.coverage_percent, 84.0)
        self.assertFalse(report.passed)
        self.assertAlmostEqual(boundary.coverage_percent, 84.0)
        self.assertTrue(boundary.passed)

    def test_brush_template_requires_safe_io_placeholders(self) -> None:
        incomplete = json.dumps(["{dataset}", "--export-path", "somewhere"])
        with self.assertRaises(room_scan.RoomScanError):
            room_scan.parse_brush_template(incomplete)

    def test_brush_template_rejects_unknown_field(self) -> None:
        template = json.dumps(
            ["{dataset}", "{output}", "{ply_name}", "{unknown}"]
        )
        with self.assertRaises(room_scan.RoomScanError):
            room_scan.parse_brush_template(template)

    def test_default_brush_command_has_dataset_and_export(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            paths = room_scan.dataset_paths(temp_dir, "room")
            template = room_scan.parse_brush_template(None)
            command = room_scan.build_brush_command(
                "brush.exe", template, paths, "room", 1200, 1280, "room.ply"
            )
        self.assertEqual(command[0], "brush.exe")
        self.assertIn("--total-steps", command)
        self.assertIn("--export-path", command)
        self.assertIn("room.ply", command)

    def test_brush_profiles_use_version_specific_step_flag(self) -> None:
        stable = room_scan.parse_brush_template(None, default_profile="v0.3")
        main = room_scan.parse_brush_template(None, default_profile="main")
        self.assertIn("--total-steps", stable)
        self.assertNotIn("--total-train-iters", stable)
        self.assertIn("--total-train-iters", main)
        self.assertNotIn("--total-steps", main)

    @mock.patch("room_scan.subprocess.run")
    def test_brush_auto_profile_uses_help_output(self, run: mock.Mock) -> None:
        run.return_value = subprocess.CompletedProcess(
            ["custom.exe", "--help"], 0, stdout="Options: --total-train-iters", stderr=""
        )
        profile = room_scan.inspect_brush_profile("custom.exe", "auto", False)
        self.assertEqual(profile, "main")
        self.assertFalse(run.call_args.kwargs["shell"])

    @mock.patch("room_scan.subprocess.run")
    def test_external_process_never_uses_shell(self, run: mock.Mock) -> None:
        run.return_value = subprocess.CompletedProcess(["tool.exe"], 0)
        with tempfile.TemporaryDirectory() as temp_dir:
            room_scan.run_external(["tool.exe", "--flag"], Path(temp_dir), False)
        self.assertFalse(run.call_args.kwargs["shell"])
        self.assertTrue(run.call_args.kwargs["check"])
        self.assertIsInstance(run.call_args.args[0], list)


class DryRunTests(unittest.TestCase):
    def run_cli(self, argv: list[str]) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = room_scan.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_capture_dry_run_needs_no_camera_and_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "datasets"
            code, output, error = self.run_cli(
                [
                    "capture",
                    "demo",
                    "--dataset-root",
                    str(root),
                    "--dry-run",
                ]
            )
            self.assertEqual(code, 0, error)
            self.assertIn("未打开摄像头", output)
            self.assertFalse(root.exists())

    def test_prepare_dry_run_needs_no_colmap_and_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "datasets"
            code, output, error = self.run_cli(
                [
                    "prepare",
                    "demo",
                    "--dataset-root",
                    str(root),
                    "--colmap",
                    str(Path(temp_dir) / "missing-colmap.exe"),
                    "--dry-run",
                ]
            )
            self.assertEqual(code, 0, error)
            self.assertIn("automatic_reconstructor", output)
            self.assertIn("--use_gpu 0", output)
            self.assertFalse(root.exists())

    def test_prepare_video_dry_run_shows_three_cpu_steps_and_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "datasets"
            code, output, error = self.run_cli(
                [
                    "prepare-video",
                    "phone",
                    "--dataset-root",
                    str(root),
                    "--colmap",
                    str(Path(temp_dir) / "missing-colmap.exe"),
                    "--dry-run",
                ]
            )
            self.assertEqual(code, 0, error)
            self.assertIn("feature_extractor", output)
            self.assertIn("sequential_matcher", output)
            self.assertIn("mapper", output)
            self.assertIn("--FeatureExtraction.max_image_size 3200", output)
            self.assertIn("--FeatureMatching.guided_matching 1", output)
            self.assertIn("--SequentialMatching.overlap 20", output)
            self.assertFalse(root.exists())

    def test_prepare_video_dry_run_uses_read_only_loop_tree_and_thread_cap(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            root = base / "datasets"
            vocab_tree = base / "local vocab tree.bin"
            vocab_tree.write_bytes(b"keep-this-tree")
            code, output, error = self.run_cli(
                [
                    "prepare-video",
                    "phone",
                    "--dataset-root",
                    str(root),
                    "--colmap",
                    str(base / "missing-colmap.exe"),
                    "--max-threads",
                    "8",
                    "--loop-detection",
                    "--vocab-tree",
                    str(vocab_tree),
                    "--dry-run",
                ]
            )

            self.assertEqual(code, 0, error)
            self.assertIn("--FeatureExtraction.num_threads 8", output)
            self.assertIn("--FeatureMatching.num_threads 8", output)
            self.assertIn("--SequentialMatching.num_threads 8", output)
            self.assertIn("--Mapper.num_threads 8", output)
            self.assertIn("--SequentialMatching.loop_detection 1", output)
            self.assertIn("--SequentialMatching.vocab_tree_path", output)
            self.assertEqual(vocab_tree.read_bytes(), b"keep-this-tree")
            self.assertFalse(root.exists())

    def test_prepare_video_loop_detection_requires_a_readable_tree(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            root = base / "datasets"
            missing_tree = base / "missing-tree.bin"
            code, _output, error = self.run_cli(
                [
                    "prepare-video",
                    "phone",
                    "--dataset-root",
                    str(root),
                    "--loop-detection",
                    "--vocab-tree",
                    str(missing_tree),
                    "--dry-run",
                ]
            )

            self.assertEqual(code, 2)
            self.assertIn("不存在或无法访问", error)
            self.assertFalse(root.exists())

    def test_prepare_video_rejects_tree_without_loop_detection(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            base = Path(temp_dir)
            root = base / "datasets"
            vocab_tree = base / "tree.bin"
            vocab_tree.write_bytes(b"tree")
            code, _output, error = self.run_cli(
                [
                    "prepare-video",
                    "phone",
                    "--dataset-root",
                    str(root),
                    "--vocab-tree",
                    str(vocab_tree),
                    "--dry-run",
                ]
            )

            self.assertEqual(code, 2)
            self.assertIn("只能与 --loop-detection 一起使用", error)
            self.assertEqual(vocab_tree.read_bytes(), b"tree")
            self.assertFalse(root.exists())

    def test_prepare_video_rejects_nonpositive_thread_cap(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "datasets"
            code, _output, error = self.run_cli(
                [
                    "prepare-video",
                    "phone",
                    "--dataset-root",
                    str(root),
                    "--max-threads",
                    "0",
                    "--dry-run",
                ]
            )

            self.assertEqual(code, 2)
            self.assertIn("最大线程数必须是正数", error)
            self.assertFalse(root.exists())

    def test_train_dry_run_needs_no_brush_and_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "datasets"
            code, output, error = self.run_cli(
                [
                    "train",
                    "demo",
                    "--dataset-root",
                    str(root),
                    "--brush",
                    str(Path(temp_dir) / "missing-brush.exe"),
                    "--iterations",
                    "100",
                    "--dry-run",
                ]
            )
            self.assertEqual(code, 0, error)
            self.assertIn("--total-steps 100", output)
            self.assertIn("demo.ply", output)
            self.assertFalse(root.exists())

    def test_cpu_reconstruct_dry_run_needs_no_tools_and_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "datasets"
            code, output, error = self.run_cli(
                [
                    "cpu-reconstruct",
                    "demo",
                    "--dataset-root",
                    str(root),
                    "--colmap",
                    str(Path(temp_dir) / "missing-colmap.exe"),
                    "--openmvs",
                    str(Path(temp_dir) / "missing-openmvs"),
                    "--max-threads",
                    "4",
                    "--dry-run",
                ]
            )
            self.assertEqual(code, 0, error)
            self.assertIn("image_undistorter", output)
            self.assertIn("DensifyPointCloud.exe", output)
            self.assertIn("--image-folder images", output)
            self.assertIn("textured-embedded.glb", output)
            self.assertFalse(root.exists())

    def test_cpu_reconstruct_high_dry_run_uses_preset_and_user_overrides(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "datasets"
            code, output, error = self.run_cli(
                [
                    "cpu-reconstruct",
                    "demo",
                    "--dataset-root",
                    str(root),
                    "--colmap",
                    str(Path(temp_dir) / "missing-colmap.exe"),
                    "--openmvs",
                    str(Path(temp_dir) / "missing-openmvs"),
                    "--preset",
                    "high",
                    "--max-resolution",
                    "2048",
                    "--max-threads",
                    "6",
                    "--dry-run",
                ]
            )
            self.assertEqual(code, 0, error)
            self.assertIn("参数预设：high", output)
            self.assertIn("--max_image_size 2048", output)
            self.assertIn("--resolution-level 0", output)
            self.assertIn("--max-resolution 2048", output)
            self.assertIn("--min-resolution 640", output)
            self.assertIn("--number-views 5", output)
            self.assertIn("--geometric-iters 2", output)
            self.assertIn("--fusion-filter 2", output)
            self.assertIn("--close-holes 15", output)
            self.assertIn("--decimate 1.0", output)
            self.assertIn("--max-texture-size 8192", output)
            self.assertIn("--max-threads 6", output)
            self.assertFalse(root.exists())


class PrepareVideoQualityGateTests(unittest.TestCase):
    @staticmethod
    def run_cli(argv: list[str]) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = room_scan.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_failed_quality_gate_returns_three_and_preserves_sparse_result(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "datasets"
            paths = room_scan.dataset_paths(root, "phone")
            paths.images.mkdir(parents=True)
            for index in range(20):
                (paths.images / f"frame_{index + 1:06d}.jpg").write_bytes(b"jpg")
            fake_colmap = Path(temp_dir) / "colmap.exe"
            fake_colmap.touch()

            def fake_run(command, *_args, **_kwargs) -> None:
                if command[1] != "mapper":
                    return
                model = paths.sparse / "0"
                model.mkdir(parents=True, exist_ok=True)
                (model / "cameras.bin").write_bytes(b"camera")
                (model / "images.bin").write_bytes(struct.pack("<Q", 16))
                (model / "points3D.bin").write_bytes(b"points")

            with mock.patch("room_scan.run_external", side_effect=fake_run):
                code, output, error = self.run_cli(
                    [
                        "prepare-video",
                        "phone",
                        "--dataset-root",
                        str(root),
                        "--colmap",
                        str(fake_colmap),
                    ]
                )

            self.assertEqual(code, room_scan.QUALITY_GATE_EXIT_CODE)
            self.assertIn("16/20", output)
            self.assertIn("80.0%", output)
            self.assertIn("质量门槛未通过", error)
            self.assertTrue((paths.sparse / "0" / "images.bin").is_file())

    def test_existing_outputs_are_rejected_without_allow_existing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "datasets"
            paths = room_scan.dataset_paths(root, "phone")
            paths.images.mkdir(parents=True)
            for index in range(20):
                (paths.images / f"frame_{index + 1:06d}.jpg").write_bytes(b"jpg")
            database = paths.project / "database.db"
            database.write_bytes(b"keep")
            fake_colmap = Path(temp_dir) / "colmap.exe"
            fake_colmap.touch()

            with mock.patch("room_scan.run_external") as run:
                code, _output, error = self.run_cli(
                    [
                        "prepare-video",
                        "phone",
                        "--dataset-root",
                        str(root),
                        "--colmap",
                        str(fake_colmap),
                    ]
                )

            self.assertEqual(code, 2)
            self.assertIn("--allow-existing", error)
            self.assertEqual(database.read_bytes(), b"keep")
            run.assert_not_called()

class CpuReconstructionSafetyTests(unittest.TestCase):
    @mock.patch("room_scan.run_external")
    @mock.patch("room_scan.locate_openmvs")
    @mock.patch("room_scan.locate_colmap")
    def test_high_preset_refuses_existing_output_before_running_tools(
        self,
        locate_colmap: mock.Mock,
        locate_openmvs: mock.Mock,
        run_external: mock.Mock,
    ) -> None:
        locate_colmap.return_value = room_scan.ToolResult(
            "COLMAP", "colmap.exe", "test"
        )
        locate_openmvs.return_value = room_scan.OpenMvsTools(
            "InterfaceCOLMAP.exe",
            "DensifyPointCloud.exe",
            "ReconstructMesh.exe",
            "TextureMesh.exe",
            "test",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "datasets"
            paths = room_scan.dataset_paths(root, "phone")
            paths.images.mkdir(parents=True)
            (paths.images / "frame_000001.jpg").write_bytes(b"image")
            model = paths.sparse / "0"
            model.mkdir(parents=True)
            (model / "cameras.bin").write_bytes(b"camera")
            (model / "images.bin").write_bytes(struct.pack("<Q", 1))
            (model / "points3D.bin").write_bytes(b"points")
            existing = paths.project / "openmvs" / "keep.txt"
            existing.parent.mkdir()
            existing.write_text("do not overwrite", encoding="utf-8")
            stdout = io.StringIO()
            stderr = io.StringIO()
            with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
                code = room_scan.main(
                    [
                        "cpu-reconstruct",
                        "phone",
                        "--dataset-root",
                        str(root),
                        "--preset",
                        "high",
                    ]
                )
            self.assertEqual(code, 2)
            self.assertIn("OpenMVS 输出目录已有内容", stderr.getvalue())
            self.assertEqual(existing.read_text(encoding="utf-8"), "do not overwrite")
        run_external.assert_not_called()


class GlbEmbeddingTests(unittest.TestCase):
    @staticmethod
    def write_glb(path: Path, document: object, binary: bytes = b"mesh") -> None:
        json_bytes = json.dumps(document, separators=(",", ":")).encode("utf-8")
        json_bytes += b" " * ((-len(json_bytes)) % 4)
        binary_padded = binary + b"\x00" * ((-len(binary)) % 4)
        total = 12 + 8 + len(json_bytes) + 8 + len(binary_padded)
        data = bytearray(struct.pack("<4sII", b"glTF", 2, total))
        data.extend(struct.pack("<II", len(json_bytes), room_scan.GLB_JSON_CHUNK))
        data.extend(json_bytes)
        data.extend(struct.pack("<II", len(binary_padded), room_scan.GLB_BIN_CHUNK))
        data.extend(binary_padded)
        path.write_bytes(data)

    @classmethod
    def write_external_glb(cls, path: Path, uri: str) -> None:
        binary = b"mesh"
        cls.write_glb(
            path,
            {
                "asset": {"version": "2.0"},
                "buffers": [{"byteLength": len(binary)}],
                "images": [{"uri": uri, "name": "room texture"}],
            },
            binary,
        )

    def test_embeds_one_png_and_updates_buffer_view(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "room-textured.glb"
            target = root / "room-textured-embedded.glb"
            texture = root / "room-textured_0.png"
            texture_data = b"\x89PNG\r\n\x1a\n" + b"fake-image"
            texture.write_bytes(texture_data)
            self.write_external_glb(source, texture.name)
            count = room_scan.embed_glb_images(source, target, root)
            document, binary = room_scan.read_glb(target)
        self.assertEqual(count, 1)
        image = document["images"][0]
        self.assertNotIn("uri", image)
        self.assertEqual(image["mimeType"], "image/png")
        view = document["bufferViews"][image["bufferView"]]
        start = view["byteOffset"]
        self.assertEqual(binary[start : start + view["byteLength"]], texture_data)
        self.assertEqual(document["buffers"][0]["byteLength"], start + len(texture_data))

    def test_embeds_png_when_glb_has_secondary_data_uri_buffer(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "room-textured.glb"
            target = root / "room-textured-embedded.glb"
            texture = root / "room-textured_0.png"
            texture_2 = root / "room-textured_1.png"
            texture_data = b"\x89PNG\r\n\x1a\n" + b"fake-image"
            texture_data_2 = b"\x89PNG\r\n\x1a\n" + b"second-image"
            texture.write_bytes(texture_data)
            texture_2.write_bytes(texture_data_2)
            secondary_uri = "data:application/octet-stream;base64,c2Vjb25kYXJ5"
            self.write_glb(
                source,
                {
                    "asset": {"version": "2.0"},
                    "buffers": [
                        {"byteLength": 4},
                        {"byteLength": 9, "uri": secondary_uri},
                    ],
                    "bufferViews": [
                        {"buffer": 0, "byteOffset": 0, "byteLength": 4},
                        {"buffer": 1, "byteOffset": 0, "byteLength": 9},
                    ],
                    "images": [{"uri": texture.name}, {"uri": texture_2.name}],
                },
            )
            count = room_scan.embed_glb_images(source, target, root)
            document, binary = room_scan.read_glb(target)

        self.assertEqual(count, 2)
        self.assertEqual(document["buffers"][1]["uri"], secondary_uri)
        self.assertEqual(document["bufferViews"][1]["buffer"], 1)
        image = document["images"][0]
        image_view = document["bufferViews"][image["bufferView"]]
        self.assertEqual(image_view["buffer"], 0)
        start = image_view["byteOffset"]
        self.assertEqual(binary[start : start + image_view["byteLength"]], texture_data)
        image_2 = document["images"][1]
        image_view_2 = document["bufferViews"][image_2["bufferView"]]
        self.assertEqual(image_view_2["buffer"], 0)
        self.assertEqual(image_view_2["byteOffset"] % 4, 0)
        start_2 = image_view_2["byteOffset"]
        self.assertGreater(start_2, start + len(texture_data))
        self.assertEqual(
            binary[start_2 : start_2 + image_view_2["byteLength"]], texture_data_2
        )

    def test_rejects_secondary_external_buffer_when_embedding(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "room-textured.glb"
            target = root / "room-textured-embedded.glb"
            texture = root / "room-textured_0.png"
            texture.write_bytes(b"\x89PNG\r\n\x1a\n" + b"fake-image")
            self.write_glb(
                source,
                {
                    "asset": {"version": "2.0"},
                    "buffers": [
                        {"byteLength": 4},
                        {"byteLength": 9, "uri": "geometry.bin"},
                    ],
                    "images": [{"uri": texture.name}],
                },
            )
            with self.assertRaisesRegex(room_scan.RoomScanError, "data: URI"):
                room_scan.embed_glb_images(source, target, root)
            self.assertFalse(target.exists())

    def test_rejects_texture_path_escape(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "model"
            root.mkdir()
            source = root / "room.glb"
            self.write_external_glb(source, "../outside.png")
            (root.parent / "outside.png").write_bytes(b"\x89PNG\r\n\x1a\n")
            with self.assertRaises(room_scan.RoomScanError):
                room_scan.embed_glb_images(source, root / "packed.glb", root)

    def test_rejects_missing_texture(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "room.glb"
            self.write_external_glb(source, "missing.png")
            with self.assertRaises(room_scan.RoomScanError):
                room_scan.embed_glb_images(source, root / "packed.glb", root)

    def test_rejects_non_object_buffer_with_clear_room_scan_error(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "invalid-buffer.glb"
            self.write_glb(
                source,
                {"asset": {"version": "2.0"}, "buffers": [4]},
            )
            with self.assertRaisesRegex(room_scan.RoomScanError, "buffer 对象"):
                room_scan.read_glb(source)

    def test_atomic_replace_failure_keeps_old_target_and_removes_temp(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "room-textured.glb"
            target = root / "room-textured-embedded.glb"
            texture = root / "room-textured_0.png"
            texture.write_bytes(b"\x89PNG\r\n\x1a\n" + b"fake-image")
            self.write_external_glb(source, texture.name)
            target.write_bytes(b"old-complete-model")
            with mock.patch(
                "room_scan.os.replace", side_effect=OSError("simulated replace failure")
            ), self.assertRaises(room_scan.RoomScanError):
                room_scan.embed_glb_images(
                    source, target, root, allow_existing=True
                )
            self.assertEqual(target.read_bytes(), b"old-complete-model")
            self.assertEqual(list(root.glob(f".{target.name}.*.tmp")), [])

    def test_atomic_writer_flushes_with_fsync(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "room-textured.glb"
            target = root / "room-textured-embedded.glb"
            texture = root / "room-textured_0.png"
            texture.write_bytes(b"\x89PNG\r\n\x1a\n" + b"fake-image")
            self.write_external_glb(source, texture.name)
            with mock.patch(
                "room_scan.os.fsync", wraps=room_scan.os.fsync
            ) as fsync:
                room_scan.embed_glb_images(source, target, root)
            self.assertTrue(target.is_file())
            fsync.assert_called_once()
            self.assertEqual(list(root.glob(f".{target.name}.*.tmp")), [])


class CameraMockTests(unittest.TestCase):
    def test_capture_default_sharpness_matches_the_builtin_camera(self) -> None:
        args = room_scan.build_parser().parse_args(["capture", "camera-test"])
        self.assertEqual(args.sharpness, 10.0)

    def test_capture_uses_camera_preview_and_hotkeys_without_real_hardware(self) -> None:
        class FakeFrame:
            def __init__(self) -> None:
                self.overlaid = False

            def copy(self):
                return FakeFrame()

        class FakeCapture:
            def __init__(self) -> None:
                self.released = False

            def isOpened(self) -> bool:
                return True

            def read(self):
                return True, FakeFrame()

            def set(self, *_args) -> bool:
                return True

            def release(self) -> None:
                self.released = True

        class SharpFrame:
            @staticmethod
            def var() -> float:
                return 250.0

        class FakeCv2:
            CAP_DSHOW = 700
            CAP_MSMF = 1400
            CAP_PROP_FRAME_WIDTH = 3
            CAP_PROP_FRAME_HEIGHT = 4
            COLOR_BGR2GRAY = 6
            CV_64F = 6
            IMWRITE_JPEG_QUALITY = 1
            WINDOW_NORMAL = 0
            FONT_HERSHEY_SIMPLEX = 0
            LINE_AA = 0
            WND_PROP_VISIBLE = 0
            error = RuntimeError

            def __init__(self) -> None:
                self.capture = FakeCapture()
                self.keys = iter((32, ord("s"), ord("q")))
                self.preview_count = 0

            def VideoCapture(self, *_args):
                return self.capture

            @staticmethod
            def namedWindow(*_args) -> None:
                return None

            @staticmethod
            def cvtColor(*_args):
                return object()

            @staticmethod
            def Laplacian(*_args):
                return SharpFrame()

            @staticmethod
            def imwrite(path: str, frame, _options) -> bool:
                if frame.overlaid:
                    raise AssertionError("保存的训练图片不应包含预览文字")
                Path(path).write_bytes(b"fake-jpeg")
                return True

            @staticmethod
            def putText(frame, *_args) -> None:
                frame.overlaid = True
                return None

            def imshow(self, *_args) -> None:
                self.preview_count += 1

            def waitKey(self, _delay: int) -> int:
                return next(self.keys)

            @staticmethod
            def getWindowProperty(*_args) -> float:
                return 1.0

            @staticmethod
            def destroyAllWindows() -> None:
                return None

        fake_cv2 = FakeCv2()
        with tempfile.TemporaryDirectory() as temp_dir, mock.patch(
            "room_scan.importlib.import_module", return_value=fake_cv2
        ):
            code = room_scan.main(
                [
                    "capture",
                    "camera-test",
                    "--dataset-root",
                    temp_dir,
                    "--interval",
                    "10",
                ]
            )
            images = Path(temp_dir) / "camera-test" / "images"
            self.assertEqual(code, 0)
            self.assertEqual(len(list(images.glob("frame_*.jpg"))), 2)
            self.assertGreaterEqual(fake_cv2.preview_count, 3)
            self.assertTrue(fake_cv2.capture.released)


class VideoImportTests(unittest.TestCase):
    class FakeFrame:
        def __init__(
            self,
            sharpness: float,
            level: float,
            shape: tuple[int, int, int] = (2160, 3840, 3),
        ) -> None:
            self.sharpness = sharpness
            self.level = level
            self.shape = shape

    class FakeGray:
        def __init__(self, sharpness: float, level: float) -> None:
            self.sharpness = sharpness
            self.level = level

    class FakeThumb:
        def __init__(self, level: float) -> None:
            self.level = level

    class FakeVariance:
        def __init__(self, value: float) -> None:
            self.value = value

        def var(self) -> float:
            return self.value

    class FakeDifference:
        def __init__(self, value: float) -> None:
            self.value = value

    class FakeCapture:
        def __init__(self, frames, fps: float) -> None:
            self.frames = list(frames)
            self.fps = fps
            self.position = 0
            self.released = False

        def isOpened(self) -> bool:
            return True

        def read(self):
            if self.position >= len(self.frames):
                return False, None
            frame = self.frames[self.position]
            self.position += 1
            return True, frame

        def get(self, property_id: int) -> float:
            if property_id == 5:
                return self.fps
            if property_id == 7:
                return float(len(self.frames))
            return 0.0

        def set(self, *_args) -> bool:
            return True

        def release(self) -> None:
            self.released = True

    class FakeCv2:
        CAP_PROP_FPS = 5
        CAP_PROP_FRAME_COUNT = 7
        CAP_PROP_ORIENTATION_AUTO = 49
        COLOR_BGR2GRAY = 6
        CV_64F = 6
        INTER_AREA = 3
        IMWRITE_JPEG_QUALITY = 1
        error = RuntimeError

        def __init__(self, frames, fps: float = 4.0, fail_write: int = 0) -> None:
            self.capture = VideoImportTests.FakeCapture(frames, fps)
            self.write_count = 0
            self.fail_write = fail_write

        def VideoCapture(self, _path: str):
            return self.capture

        @staticmethod
        def resize(value, size, interpolation=None):
            del interpolation
            if isinstance(value, VideoImportTests.FakeFrame):
                return VideoImportTests.FakeFrame(
                    value.sharpness,
                    value.level,
                    (size[1], size[0], 3),
                )
            return VideoImportTests.FakeThumb(value.level)

        @staticmethod
        def cvtColor(frame, _mode):
            return VideoImportTests.FakeGray(frame.sharpness, frame.level)

        @staticmethod
        def Laplacian(gray, _depth):
            return VideoImportTests.FakeVariance(gray.sharpness)

        @staticmethod
        def absdiff(current, previous):
            return VideoImportTests.FakeDifference(
                abs(current.level - previous.level)
            )

        @staticmethod
        def mean(difference):
            return (difference.value, 0.0, 0.0, 0.0)

        def imwrite(self, path: str, _frame, _options) -> bool:
            self.write_count += 1
            if self.fail_write and self.write_count == self.fail_write:
                return False
            Path(path).write_bytes(b"fake-jpeg")
            return True

    @staticmethod
    def run_cli(argv: list[str]) -> tuple[int, str, str]:
        stdout = io.StringIO()
        stderr = io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = room_scan.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_defaults_fit_4k_video_without_importing_every_frame(self) -> None:
        args = room_scan.build_parser().parse_args(
            ["import-video", "phone-room", "phone.mp4"]
        )
        self.assertEqual(args.target_fps, 2.5)
        self.assertEqual(args.max_width, 2560)
        self.assertEqual(args.max_frames, 800)
        self.assertGreater(args.sharpness, 0)
        self.assertGreater(args.motion_threshold, 0)

    def test_atomic_frame_publish_retries_a_transient_windows_lock(self) -> None:
        fake_cv2 = self.FakeCv2([])
        frame = self.FakeFrame(100, 0)
        real_replace = room_scan.os.replace
        attempts = 0

        def transient_replace(source, target):
            nonlocal attempts
            attempts += 1
            if attempts == 1:
                raise PermissionError(5, "simulated antivirus lock")
            return real_replace(source, target)

        with tempfile.TemporaryDirectory() as temp_dir, mock.patch(
            "room_scan.os.replace", side_effect=transient_replace
        ), mock.patch("room_scan.time.sleep") as sleep:
            target = Path(temp_dir) / "frame_000001.jpg"
            room_scan.atomic_write_video_frame(fake_cv2, frame, target, 97)
            self.assertEqual(target.read_bytes(), b"fake-jpeg")
            self.assertEqual(attempts, 2)
            sleep.assert_called_once()
            self.assertEqual(list(target.parent.glob(".*.tmp.jpg")), [])

    def test_dry_run_validates_source_but_writes_nothing(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "phone.mp4"
            source.write_bytes(b"read-only-source")
            dataset_root = root / "datasets"
            code, output, error = self.run_cli(
                [
                    "import-video",
                    "phone-room",
                    str(source),
                    "--dataset-root",
                    str(dataset_root),
                    "--dry-run",
                ]
            )
            self.assertEqual(code, 0, error)
            self.assertIn("未解码", output)
            self.assertFalse(dataset_root.exists())
            self.assertEqual(source.read_bytes(), b"read-only-source")

    def test_filters_by_rate_sharpness_and_motion_then_numbers_continuously(self) -> None:
        frames = [
            self.FakeFrame(100, 0),
            self.FakeFrame(1, 99),
            self.FakeFrame(5, 5),
            self.FakeFrame(1, 99),
            self.FakeFrame(100, 0.5),
            self.FakeFrame(1, 99),
            self.FakeFrame(100, 5),
        ]
        fake_cv2 = self.FakeCv2(frames, fps=4.0)
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "phone.mp4"
            source.write_bytes(b"source-must-not-change")
            with mock.patch(
                "room_scan.importlib.import_module", return_value=fake_cv2
            ):
                code, output, error = self.run_cli(
                    [
                        "import-video",
                        "phone-room",
                        str(source),
                        "--dataset-root",
                        str(root / "datasets"),
                        "--target-fps",
                        "2",
                        "--max-width",
                        "1000",
                    ]
                )
            images = root / "datasets" / "phone-room" / "images"
            self.assertEqual(code, 0, error)
            self.assertEqual(
                [path.name for path in sorted(images.glob("*.jpg"))],
                ["frame_000001.jpg", "frame_000002.jpg"],
            )
            self.assertIn("全部模糊而跳过：1 个窗口", output)
            self.assertIn("全部近重复而跳过：1 个窗口", output)
            self.assertIn("最终保存：2 帧", output)
            self.assertEqual(source.read_bytes(), b"source-must-not-change")
            self.assertTrue(fake_cv2.capture.released)
            self.assertEqual(list(images.glob(".*.tmp.jpg")), [])
            manifest = json.loads(
                (root / "datasets" / "phone-room" / "video-import-manifest.json")
                .read_text(encoding="utf-8")
            )
            self.assertFalse(manifest["source"]["copied_into_dataset"])
            self.assertEqual(manifest["result"]["saved_frames"], 2)
            self.assertEqual(
                manifest["settings"]["selection"],
                "sharpest_eligible_frame_per_time_window",
            )

    def test_nonempty_images_require_explicit_append_and_never_overwrite(self) -> None:
        fake_cv2 = self.FakeCv2([self.FakeFrame(100, 0)])
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "phone.mp4"
            source.write_bytes(b"video")
            images = root / "datasets" / "phone-room" / "images"
            images.mkdir(parents=True)
            old = images / "frame_000003.jpg"
            old.write_bytes(b"old")
            old_manifest = images.parent / "video-import-manifest.json"
            old_manifest.write_text('{"old": true}\n', encoding="utf-8")
            base = [
                "import-video",
                "phone-room",
                str(source),
                "--dataset-root",
                str(root / "datasets"),
            ]
            code, _output, error = self.run_cli([*base, "--dry-run"])
            self.assertEqual(code, 2)
            self.assertIn("--allow-existing", error)
            with mock.patch(
                "room_scan.importlib.import_module", return_value=fake_cv2
            ):
                code, _output, error = self.run_cli([*base, "--allow-existing"])
            self.assertEqual(code, 0, error)
            self.assertEqual(old.read_bytes(), b"old")
            self.assertEqual((images / "frame_000004.jpg").read_bytes(), b"fake-jpeg")
            self.assertEqual(
                old_manifest.read_text(encoding="utf-8"), '{"old": true}\n'
            )
            self.assertTrue(
                (images.parent / "video-import-manifest-002.json").is_file()
            )

    def test_failed_import_cleans_only_frames_created_by_this_run(self) -> None:
        fake_cv2 = self.FakeCv2(
            [self.FakeFrame(100, 0), self.FakeFrame(100, 5)],
            fps=2.0,
            fail_write=2,
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / "phone.mp4"
            source.write_bytes(b"video")
            with mock.patch(
                "room_scan.importlib.import_module", return_value=fake_cv2
            ):
                code, _output, error = self.run_cli(
                    [
                        "import-video",
                        "phone-room",
                        str(source),
                        "--dataset-root",
                        str(root / "datasets"),
                        "--target-fps",
                        "2",
                    ]
                )
            images = root / "datasets" / "phone-room" / "images"
            self.assertEqual(code, 2)
            self.assertIn("无法编码视频帧", error)
            self.assertEqual(list(images.glob("*.jpg")), [])
            self.assertEqual(list(images.glob(".*.tmp.jpg")), [])
            self.assertEqual(list(images.parent.glob("*.json")), [])
            self.assertEqual(source.read_bytes(), b"video")
            self.assertTrue(fake_cv2.capture.released)


if __name__ == "__main__":
    unittest.main()
