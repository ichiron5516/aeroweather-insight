# 台湾 eAIP（HTML）用：韓国用の共通処理（座標・測地・境界の文章）を、台湾の HTML で使う
import sys, json
sys.path.insert(0, '/home/claude/kr/tools')
import kr_lib
kr_lib.H = json.load(open('/home/claude/tw/TW_eAIP_2026-10-29_html.json'))
from kr_lib import *
