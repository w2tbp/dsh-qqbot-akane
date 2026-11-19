"""生成对拍语料 + HF 参考基准（确定性，不依赖网络）。

覆盖类：纯中文、中英混排、ASCII 标点粘连、全角、控制字符、变音符、
大写、emoji/星平面、零宽、超长词(>100字符)、纯标点、空串、空白串、
以及带 QQ 形状的文本（<@!123>、【表情: 开心】、时间戳、URL）。
"""
import json
import os
import random

from tokenizers import Tokenizer

# 权重目录与输出都相对本文件定位，可用环境变量覆盖（不再写死 /tmp 路径）。
HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.environ.get("AKANE_EMBED_MODEL_DIR") or os.path.normpath(os.path.join(HERE, "..", "model"))
OUT = os.environ.get("AKANE_TOKENIZER_GOLDEN_OUT") or os.path.join(HERE, "golden.json")
tk = Tokenizer.from_file(DIR + "/tokenizer.json")

random.seed(20261119)

BASE = [
    "猫粮太贵了，一包要两百多",
    "这个猫粮的价格不便宜",
    "今天加班到十点才走",
    "她喜欢红色的雨伞",
    "我家熊猫好胖",
    "这猫粮多少钱",
    "龙猫好看吗",
    "我们上次说的那张图里是什么",
    "<@!123456789> 你在吗",
    "【表情: 开心】",
    "收到 2026-11-19 17:30 的记录",
    "详见 https://example.com/a_b?x=1&y=2",
    "vim :q 和 git --amend",
    "C++/Rust 都行",
    "他说“好”——真的好吗？",
    "全角ＡＢＣ１２３",
    "éclair accent",
    "ß 和 ẞ 的区别",
    "emoji 😀🎉 也在",
    "x​y 零宽",
    "控制\x01字",
    "  多余   空格   测试  ",
    "换行\n测试\t制表",
    "abcdefghijklmnopqrstuvwxyz" * 4,
    "",
    "   ",
    "。",
    "！?.,;:—…",
    "的的的的的",
    "猫",
    "A",
    "1",
    "😀",
    "中文abc中文",
    "①②③ 序号",
    "Ⅷ ⑨ ㎡",
    "M·U S I C",
    "３.14159",
    "AI 和 ML 的区别",
    "混English在中间",
    "HELLO world",
    "Cat 喜欢 Milk",
    "2026年11月19日",
]

PIECE = [
    "猫", "狗", "她", "喜欢", "雨伞", "加班", "熊猫", "龙猫", "价格", "不便宜",
    "a", "B", "cat", "Dog", "HELLO", "world", "123", "3.14", "-", "–", "—",
    "，", "。", "、", "「", "」", "【", "】", "…", "！", "？", "：", "；",
    "\t", "\n", " ", " ", "​", "é", "ß", "😀", "Ａ", "ａ",
]

rows = [{"text": s} for s in BASE]

for _ in range(260):
    n = random.randint(1, 7)
    rows.append({"text": "".join(random.choice(PIECE) for _ in range(n))})

for _ in range(60):
    words = [random.choice(PIECE) for _ in range(random.randint(2, 5))]
    rows.append({"text": " ".join(words)})

seen = set()
uniq = []
for r in rows:
    if r["text"] in seen:
        continue
    seen.add(r["text"])
    uniq.append(r)

out = []
for r in uniq:
    enc = tk.encode(r["text"], add_special_tokens=True)
    out.append({"text": r["text"], "ids": enc.ids, "tokens": enc.tokens})

cfg = json.load(open(DIR + "/tokenizer.json"))
json.dump(
    {
        "model": "Xenova/bge-small-zh-v1.5",
        "ref": "tokenizers(rust) — HF 参考实现",
        "normalizer": cfg["normalizer"],
        "pre_tokenizer": cfg["pre_tokenizer"],
        "model_config": {
            "type": cfg["model"]["type"],
            "unk_token": cfg["model"]["unk_token"],
            "continuing_subword_prefix": cfg["model"]["continuing_subword_prefix"],
            "max_input_chars_per_word": cfg["model"]["max_input_chars_per_word"],
        },
        "rows": out,
    },
    open(OUT, "w"),
    ensure_ascii=False,
)
print("rows:", len(out), "tokens:", sum(len(r["ids"]) for r in out))
print("written:", OUT, "（这是候选基准，确认无误后才手工覆盖 ../tokenizer-golden.json）")
