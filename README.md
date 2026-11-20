# Sysmac 工程离线解析

在 DeepSeek Harness 里直接读欧姆龙 **Sysmac Studio** 的 `.smc2` 工程文件——不需要装 Sysmac Studio，不联网，也不依赖 Python。

## 能力

`.smc2` 本质是一个 ZIP 容器，内部按 `<SolutionId>/<EntityId>.xml` 存放各类实体。本插件在宿主进程内解 ZIP 并解析其中三类内容：

| 工具 | 作用 |
| --- | --- |
| `sysmac_list_slwd_entries` | 列出所有含 `[SLWD` 标记的条目（变量表），带条目名与字符数 |
| `sysmac_read_slwd_raw` | 读取指定条目（变量表）的原始文本 |
| `sysmac_read_oem_manifest` | 读取 `.oem` 工程实体清单原文（XML，含全部实体的层级、类型、名称） |
| `sysmac_read_pou_body` | 读取 PouBody（程序逻辑体）源码，并渲染成可读的梯形图元素序列 |

`sysmac_read_pou_body` 会额外给出**实体层级路径**（如 `工程 → 控制器 → POUs → 程序 → Program0 → Section0`）、逻辑语言、梯级数量，以及每条 rung 的触点/线圈/指令框解读。

## 典型用法

```
这份 .smc2 里有哪些程序？
→ sysmac_read_pou_body(path="C:/项目/一号机.smc2")     // 多个逻辑体时会列出全部候选

看看 Program0 的第一段梯形图
→ sysmac_read_pou_body(path=..., entry_name="Section0")

有哪些全局变量表？
→ sysmac_list_slwd_entries(path=...)

把变量表原文给我
→ sysmac_read_slwd_raw(path=..., entry_name="<GUID>.xml")
```

`entry_name` 支持三种写法：完整条目名、`<GUID>.xml`、裸 GUID。

## 实现与边界

- **零依赖**：ZIP 用 `node:zlib` 的 `inflateRaw` 解，`.oem` 用内置标签扫描器解析，不引入任何 npm 依赖，也不起子进程。
- **只读**：不修改、不回写 `.smc2`。
- **梯形图解读**：覆盖 `LD`（触点）、`ST`（线圈）、`F`（指令）、`FB`（功能块）、`IST`（内联 ST 块）、`HL`（连线）。遇到 ST / FBD 等其他语言的逻辑体，会给出源码原文并说明不是梯形图 JSON。
- **已知限制**：`.oem` 的父级还原依赖 `ChildEntities` 嵌套；清单缺失时退化为内容嗅探（JSON 且含 `CLs` / `__type`）。ZIP64 与加密条目不支持——这在 Sysmac Studio 正常导出的工程里不会出现。

## 安装

```bash
dsh plugin --profile <your-profile> add dsh-sysmac-offline
```

或在 DSH 的 **Plugins** 页面搜索安装。

## 许可

MIT。与 OMRON 无隶属关系；Sysmac Studio 是 OMRON 公司的商标。
