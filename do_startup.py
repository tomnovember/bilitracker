import os, subprocess, sys

STARTUP = os.path.expandvars(r'%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup')
VBS_PATH = os.path.join(STARTUP, 'BiliTrackerServer.vbs')

# 自动定位：pythonw 与当前 python 同目录，server.py 在本脚本旁边的 server/ 下
_here = os.path.dirname(os.path.abspath(__file__))
PYTHONW = sys.executable.replace('python.exe', 'pythonw.exe')
if not os.path.exists(PYTHONW):
    PYTHONW = sys.executable   # fallback：有黑窗口但能用
SERVER_DIR = os.path.join(_here, 'server')
SERVER     = os.path.join(SERVER_DIR, 'server.py')

vbs_lines = [
    'Set WshShell = CreateObject("WScript.Shell")',
    f'WshShell.CurrentDirectory = "{SERVER_DIR}"',
    f'WshShell.Run Chr(34) & "{PYTHONW}" & Chr(34) & " " & Chr(34) & "{SERVER}" & Chr(34), 0, False',
]

with open(VBS_PATH, 'w', encoding='utf-8') as f:
    f.write('\r\n'.join(vbs_lines))

print(f'[OK] 已写入启动脚本: {VBS_PATH}')
print('     下次登录后自动静默启动，无任何窗口')

# 立即在后台启动一次
proc = subprocess.Popen(
    [PYTHONW, SERVER],
    cwd=SERVER_DIR,
    creationflags=0x00000008,  # DETACHED_PROCESS
)
print(f'[OK] Server 已在后台启动 (pid={proc.pid})')
print('     验证: 打开 http://localhost:9876/api/health')
