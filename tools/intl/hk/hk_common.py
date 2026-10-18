# 香港 eAIP（HTML）用：韓国用の共通処理を香港の HTML で使う
import sys, json
sys.path.insert(0, '/home/claude/kr/tools')
import kr_lib
kr_lib.H = json.load(open('/home/claude/hk/HK_eAIP_2026-10-29_html.json'))
from kr_lib import *
