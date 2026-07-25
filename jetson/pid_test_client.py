import argparse
import asyncio
import json
import sys
import uuid


TERMINAL_STATES = {"completed", "failed", "cancelled", "stopped"}


def build_command(args):
    request_id = args.request_id or f"pid-test-{uuid.uuid4()}"
    if args.operation == "stop":
        return {"cmd": "stop", "request_id": request_id}
    if args.operation == "distance":
        return {
            "cmd": "move_distance",
            "request_id": request_id,
            "direction": args.direction,
            "distance_mm": args.distance_mm,
            "max_speed_mmps": args.max_speed_mmps,
            "timeout_s": args.timeout_s,
        }
    return {
        "cmd": "turn_angle",
        "request_id": request_id,
        "direction": args.direction,
        "angle_deg": args.angle_deg,
        "max_speed_mmps": args.max_speed_mmps,
        "timeout_s": args.timeout_s,
    }


async def execute(url, command, wait_timeout_s):
    import websockets

    async with websockets.connect(url, open_timeout=5, ping_interval=10, ping_timeout=5) as socket:
        await socket.send(json.dumps(command))
        print("已发送：", json.dumps(command, ensure_ascii=False))
        async with asyncio.timeout(wait_timeout_s):
            async for raw in socket:
                try:
                    message = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if message.get("type") != "control" or message.get("request_id") != command["request_id"]:
                    continue
                print(json.dumps(message, ensure_ascii=False))
                if message.get("state") in TERMINAL_STATES:
                    return 0 if message.get("state") in {"completed", "stopped"} else 2
    return 3


def parser():
    root = argparse.ArgumentParser(description="Jetson 距离/转角 PID 安全测试客户端")
    root.add_argument("--url", default="ws://127.0.0.1:8765", help="Jetson WebSocket 地址")
    root.add_argument("--request-id")
    root.add_argument("--execute", action="store_true", help="真实发送命令；省略时只打印 JSON")
    operations = root.add_subparsers(dest="operation", required=True)

    operations.add_parser("stop", help="立即停车；不需要 --execute")

    distance = operations.add_parser("distance", help="按距离移动")
    distance.add_argument("--direction", choices=("forward", "backward"), default="forward")
    distance.add_argument("--distance-mm", type=float, default=50.0)
    distance.add_argument("--max-speed-mmps", type=float, default=75.0)
    distance.add_argument("--timeout-s", type=float, default=10.0)

    turn = operations.add_parser("turn", help="按角度转向")
    turn.add_argument("--direction", choices=("left", "right"), default="left")
    turn.add_argument("--angle-deg", type=float, default=5.0)
    turn.add_argument("--max-speed-mmps", type=float, default=75.0)
    turn.add_argument("--timeout-s", type=float, default=10.0)
    return root


def main():
    args = parser().parse_args()
    command = build_command(args)
    print(json.dumps(command, ensure_ascii=False, indent=2))
    if args.operation != "stop" and not args.execute:
        print("未发送。确认车轮架空并准备物理急停后，加 --execute 才会执行。")
        return 0
    try:
        return asyncio.run(execute(args.url, command, max(5.0, command.get("timeout_s", 5.0) + 5.0)))
    except TimeoutError:
        print("等待设备回执超时；请立即使用物理急停并检查 Jetson 日志。", file=sys.stderr)
        return 4
    except Exception as error:
        print(f"测试失败：{error}", file=sys.stderr)
        return 5


if __name__ == "__main__":
    raise SystemExit(main())
