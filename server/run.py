import sys, os
_here = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _here)
os.chdir(_here)
exec(open(os.path.join(_here, 'server.py'), encoding='utf-8').read())
