import json
import os
import tokenizers
from tokenizers import Tokenizer

# 早期那份 42 行清单的 dump（历史证据，不是现网基准）。输出单独一个文件，
# 别写 golden.json —— 那份 schema 不同（ref 是 python 版本号、带 truncation、indent=1），
# 覆盖上去会把提交进仓库的 349 行基准换掉。
HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.environ.get("AKANE_EMBED_MODEL_DIR") or os.path.normpath(os.path.join(HERE, "..", "model"))
OUT = os.path.join(HERE, "golden-ref-dump.json")
tk = Tokenizer.from_file(DIR + "/tokenizer.json")
_cfg = json.load(open(DIR + "/tokenizer.json"))
print("tokenizers", tokenizers.__version__)

EXTRA = [
    "猫粮太贵了，一包要两百多", "这个猫粮的价格不便宜", "今天加班到十点才走",
    "她喜欢红色的雨伞", "我家熊猫好胖", "这猫粮多少钱", "龙猫好看吗",
    "我们上次说的那张图里是什么",
    "Cat 喜欢 Milk", "HELLO world", "café 里见面", "hello, world!",
    "AI 和 ML 的区别", "  多余   空格   测试  ", "换行\n测试\t制表",
    "emoji 😀 也在", "全角ＡＢＣ１２３", "abcdefghijklmnopqrstuvwxyz" * 4,
    "混English在中间", "2026年11月19日 17:30", "①②③ 序号",
    "的的的的的", "", "   ", "。", "Ⅷ ⑨ ㎡", "vim :q 和 git --amend",
    "ß 和 ẞ", "éclair accent 和中文混", "x​y 零宽",
    "控制\x01字", "他说「好」", "——破折号", "…省略号",
    "猫", "A", "1", "😀", "中文abc中文",
]

rows = []
for s in EXTRA:
    enc = tk.encode(s, add_special_tokens=True)
    rows.append({"text": s, "ids": enc.ids, "tokens": enc.tokens})

json.dump(
    {
        "model": "Xenova/bge-small-zh-v1.5",
        "ref": "tokenizers " + tokenizers.__version__,
        "truncation": _cfg["truncation"],
        "normalizer": _cfg["normalizer"],
        "pre_tokenizer": _cfg["pre_tokenizer"],
        "rows": rows,
    },
    open(OUT, "w"),
    ensure_ascii=False,
    indent=1,
)
print("rows:", len(rows), "total_tokens:", sum(len(r["ids"]) for r in rows))
