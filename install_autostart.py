"""
BiliTracker 开机自启安装脚本
用法: python install_autostart.py [install|uninstall|status]
原理: 用 Windows Task Scheduler 在用户登录时静默启动 server.py（无控制台窗口）
"""
import sys
import os
import subprocess
import shutil

TASK_NAME = "BiliTrackerServer"
SERVER_DIR = os.path.dirname(os.path.abspath(__file__)) + r"\server"
SERVER_SCRIPT = os.path.join(SERVER_DIR, "server.py")


def find_pythonw():
    """找 pythonw.exe（与当前 python.exe 同目录，运行时无控制台窗口）"""
    python = sys.executable  # 当前 python.exe 路径
    pythonw = python.replace("python.exe", "pythonw.exe")
    if os.path.exists(pythonw):
        return pythonw
    # conda/venv 环境可能在 Scripts 子目录
    scripts = os.path.join(os.path.dirname(python), "pythonw.exe")
    if os.path.exists(scripts):
        return scripts
    return python  # fallback 用 python.exe（有黑窗口）


def install():
    pythonw = find_pythonw()
    print(f"Python:  {pythonw}")
    print(f"Script:  {SERVER_SCRIPT}")

    if not os.path.exists(SERVER_SCRIPT):
        print(f"[✗] 找不到 server.py: {SERVER_SCRIPT}")
        sys.exit(1)

    # 用 schtasks 创建任务：登录时运行，延迟30秒（等网络就绪）
    cmd = [
        "schtasks", "/Create", "/F",
        "/TN", TASK_NAME,
        "/TR", f'"{pythonw}" "{SERVER_SCRIPT}"',
        "/SC", "ONLOGON",
        "/DELAY", "0:30",          # 延迟30秒
        "/RL", "HIGHEST",          # 以最高权限运行（避免网络权限问题）
        "/IT",                     # 只在用户登录时运行
    ]

    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode == 0:
        print(f"[✓] 已注册开机自启任务: {TASK_NAME}")
        print(f"    下次登录后约30秒自动启动，无需手动操作。")
        print(f"\n    如需立即启动: schtasks /Run /TN {TASK_NAME}")
    else:
        print(f"[✗] 注册失败:\n{result.stderr}")
        sys.exit(1)


def uninstall():
    result = subprocess.run(
        ["schtasks", "/Delete", "/TN", TASK_NAME, "/F"],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        print(f"[✓] 已移除开机自启任务: {TASK_NAME}")
    else:
        print(f"[!] {result.stderr.strip() or '任务不存在'}")


def status():
    result = subprocess.run(
        ["schtasks", "/Query", "/TN", TASK_NAME, "/FO", "LIST"],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        print(result.stdout)
    else:
        print(f"[!] 任务 {TASK_NAME} 不存在（未安装自启）")


def start_now():
    result = subprocess.run(
        ["schtasks", "/Run", "/TN", TASK_NAME],
        capture_output=True, text=True
    )
    if result.returncode == 0:
        print(f"[✓] 已触发任务启动，server 正在后台运行")
    else:
        print(f"[✗] {result.stderr}")


def nssm_path():
    """找 nssm.exe"""
    # winget 安装路径
    for candidate in [
        shutil.which("nssm"),
        r"C:\ProgramData\chocolatey\bin\nssm.exe",
        r"C:\tools\nssm\win64\nssm.exe",
    ]:
        if candidate and os.path.exists(candidate):
            return candidate
    return None


def service_install():
    """用 NSSM 注册为 Windows 服务，崩溃自动重启"""
    nssm_exe = nssm_path()
    if not nssm_exe:
        print("[!] 未找到 nssm.exe，正在尝试用 winget 安装...")
        r = subprocess.run(["winget", "install", "NSSM.NSSM", "--silent"], capture_output=True, text=True)
        if r.returncode != 0:
            print("[✗] winget 安装失败，请手动下载: https://nssm.cc/download")
            print("    下载后解压，把 nssm.exe 放到系统 PATH 里，再重新运行此脚本")
            sys.exit(1)
        # 刷新 PATH 后重新查找
        import importlib
        nssm_exe = shutil.which("nssm")
        if not nssm_exe:
            # winget 常见安装位置
            for p in [r"C:\ProgramData\chocolatey\bin\nssm.exe",
                      r"C:\Program Files\NSSM\nssm.exe",
                      r"C:\tools\nssm\win64\nssm.exe"]:
                if os.path.exists(p):
                    nssm_exe = p
                    break
        if not nssm_exe:
            print("[✗] 安装后仍找不到 nssm.exe，请重新打开终端再运行此脚本")
            sys.exit(1)
        print(f"[✓] NSSM 已安装: {nssm_exe}")

    def run_nssm(args):
        return subprocess.run([nssm_exe] + args, capture_output=True, text=True)

    pythonw = find_pythonw()
    print(f"Python:  {pythonw}")
    print(f"Script:  {SERVER_SCRIPT}")
    print(f"NSSM:    {nssm_exe}")

    # 注册服务
    run_nssm(["install", TASK_NAME, pythonw, SERVER_SCRIPT])
    run_nssm(["set", TASK_NAME, "AppDirectory", SERVER_DIR])
    run_nssm(["set", TASK_NAME, "DisplayName", "BiliTracker Server"])
    run_nssm(["set", TASK_NAME, "Description", "BiliTracker 本地API服务"])
    run_nssm(["set", TASK_NAME, "Start", "SERVICE_AUTO_START"])
    # 崩溃后5秒自动重启
    run_nssm(["set", TASK_NAME, "AppRestartDelay", "5000"])
    run_nssm(["set", TASK_NAME, "AppStopMethodSkip", "6"])
    # 日志输出到文件
    log_dir = os.path.join(os.path.dirname(SERVER_DIR), "logs")
    os.makedirs(log_dir, exist_ok=True)
    run_nssm(["set", TASK_NAME, "AppStdout", os.path.join(log_dir, "server.log")])
    run_nssm(["set", TASK_NAME, "AppStderr", os.path.join(log_dir, "server_err.log")])
    run_nssm(["set", TASK_NAME, "AppRotateFiles", "1"])
    run_nssm(["set", TASK_NAME, "AppRotateSeconds", "86400"])  # 每天滚动日志

    r = run_nssm(["start", TASK_NAME])
    if r.returncode == 0:
        print(f"\n[✓] 服务已注册并启动: {TASK_NAME}")
        print(f"    开机自动运行，崩溃后5秒自动重启")
        print(f"    日志: {log_dir}")
        print(f"\n    管理命令:")
        print(f"    停止: nssm stop {TASK_NAME}")
        print(f"    启动: nssm start {TASK_NAME}")
        print(f"    卸载: python install_autostart.py service-uninstall")
    else:
        print(f"[!] {r.stderr.strip()}")
        print(f"    服务已注册，但启动失败——可能需要管理员权限")
        print(f"    请以管理员身份运行: nssm start {TASK_NAME}")


def service_uninstall():
    nssm = nssm_path()
    if not nssm:
        print("[✗] 未找到 nssm.exe")
        return
    subprocess.run([nssm, "stop", TASK_NAME], capture_output=True)
    r = subprocess.run([nssm, "remove", TASK_NAME, "confirm"], capture_output=True, text=True)
    if r.returncode == 0:
        print(f"[✓] 服务已卸载: {TASK_NAME}")
    else:
        print(f"[✗] {r.stderr}")


if __name__ == "__main__":
    action = sys.argv[1] if len(sys.argv) > 1 else "help"
    if action == "install":
        install()
    elif action == "uninstall":
        uninstall()
    elif action == "status":
        status()
    elif action == "start":
        start_now()
    elif action == "service":
        service_install()
    elif action == "service-uninstall":
        service_uninstall()
    else:
        print("用法: python install_autostart.py <命令>")
        print()
        print("  install          用 Task Scheduler 注册开机自启（无崩溃重启）")
        print("  start            立即在后台运行 server")
        print("  status           查看 Task Scheduler 任务状态")
        print("  uninstall        移除 Task Scheduler 任务")
        print()
        print("  service          用 NSSM 注册为系统服务（推荐，崩溃自动重启）")
        print("  service-uninstall 卸载 NSSM 服务")
