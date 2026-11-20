# dsh-sysmac-offline

Read OMRON **Sysmac Studio** `.smc2` projects directly inside DeepSeek Harness — without installing Sysmac Studio, without network access, and without Python.

## What it does

A `.smc2` file is a ZIP container that stores entities as `<SolutionId>/<EntityId>.xml`. The plugin unpacks the archive inside the host process and exposes three kinds of content:

| Tool | Purpose |
| --- | --- |
| `sysmac_list_slwd_entries` | List every entry that carries an `[SLWD` marker (variable tables), with entry name and size |
| `sysmac_read_slwd_raw` | Return the raw text of one variable-table entry |
| `sysmac_read_oem_manifest` | Return the `.oem` entity manifest (XML: hierarchy, types and names of every entity) |
| `sysmac_read_pou_body` | Return the PouBody source and render it as a readable ladder-element sequence |

`sysmac_read_pou_body` also reports the **entity path** (for example `Project → Controller → POUs → Program → Program0 → Section0`), the logic language, the rung count, and per-rung contact/coil/instruction details.

## Usage

```
Which programs does this .smc2 contain?
→ sysmac_read_pou_body(path="C:/projects/machine-1.smc2")   // lists candidates when there are several

Show the first ladder section of Program0
→ sysmac_read_pou_body(path=..., entry_name="Section0")

Which global variable tables exist?
→ sysmac_list_slwd_entries(path=...)

Give me the raw variable table
→ sysmac_read_slwd_raw(path=..., entry_name="<GUID>.xml")
```

`entry_name` accepts a full entry name, `<GUID>.xml`, or a bare GUID.

## Implementation and limits

- **Zero dependencies**: the ZIP is inflated with `node:zlib`'s `inflateRaw`, and `.oem` is parsed with a built-in tag scanner. No npm dependencies and no child processes.
- **Read-only**: `.smc2` files are never modified or written back.
- **Ladder rendering** covers `LD` (contacts), `ST` (coils), `F` (instructions), `FB` (function blocks), `IST` (inline ST blocks) and `HL` (connectors). For logic bodies in other languages the raw source is returned with a note.
- **Known limits**: parent resolution relies on `ChildEntities` nesting and falls back to content sniffing (JSON containing `CLs` / `__type`) when the manifest is missing. ZIP64 and encrypted entries are not supported, which does not occur in projects exported by Sysmac Studio.

## Install

```bash
dsh plugin --profile <your-profile> add dsh-sysmac-offline
```

Or install from the **Plugins** page in DSH.

## License

MIT. Not affiliated with OMRON; Sysmac Studio is a trademark of OMRON Corporation.
