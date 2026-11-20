# Sysmac 工程离线解析（详情）

在 DeepSeek Harness 里读欧姆龙 Sysmac Studio 的 `.smc2` 工程文件，全程离线。

## 提供的工具

- **`sysmac_list_slwd_entries`** —— 列出所有含 `[SLWD` 标记的条目（变量表），返回条目名与字符数。
- **`sysmac_read_slwd_raw`** —— 读取指定变量表条目的原始文本。
- **`sysmac_read_oem_manifest`** —— 读取 `.oem` 工程实体清单原文，含全部实体的层级、类型与名称。
- **`sysmac_read_pou_body`** —— 读取 PouBody（程序逻辑体）源码，并渲染每条 rung 的触点、线圈与指令框。

调用 `sysmac_read_pou_body` 且工程里有多个逻辑体时，工具会先列出全部候选条目；也可以直接传完整条目名、`<GUID>.xml` 或裸 GUID 指定其一。

## 使用流程

1. 先用 `sysmac_read_oem_manifest` 或 `sysmac_read_pou_body`（不传条目名）摸清工程结构。
2. 用 `sysmac_list_slwd_entries` 找到变量表，再按需用 `sysmac_read_slwd_raw` 取原文。
3. 用 `sysmac_read_pou_body` 指定条目，得到实体路径、逻辑语言、梯级数与逐条解读。

## 限制

- 只读：不修改、不回写 `.smc2`。
- 梯形图解读覆盖 `LD` / `ST` / `F` / `FB` / `IST` / `HL`；ST、FBD 等其他语言的逻辑体只给源码原文并注明。
- `.oem` 缺失时退化为内容嗅探（JSON 且含 `CLs` / `__type`）。
- 不支持 ZIP64 与加密条目（Sysmac Studio 正常导出的工程不会出现）。
