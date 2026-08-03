// src/summary.js
export function renderSummary (report) {
  const lines = []
  const title = report.dryRun ? 'Mod publish (dry run)' : 'Mod publish'
  lines.push(`## ${title}`, '')

  const sourceLabel = report.source.branch ?? report.source.ref
  lines.push(`Built from **${sourceLabel}** at \`${short(report.source.sha)}\`, using \`${report.configPath}\`.`)
  if (report.dryRun) {
    lines.push('', 'Nothing was committed or pushed. This is what a real run would do.')
  }
  lines.push('')

  for (const mod of report.mods) {
    lines.push(...renderMod(mod, report))
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

function renderMod (mod, report) {
  const lines = [`### \`${mod.root}\` → \`${mod.target}\``, '']

  for (const warning of mod.warnings) {
    lines.push(`> ⚠ **Warning.** ${warning}`, '')
  }

  if (mod.unchanged) {
    lines.push('**no changes — nothing to publish.** The payload is identical to what is already on the branch.', '')
  } else if (report.dryRun) {
    lines.push(
      `Would ${mod.created ? 'create' : 'commit to'} \`${mod.target}\` with ` +
      `${count(mod.fileCount)} (${formatBytes(mod.totalBytes)}).`,
      ''
    )
  } else {
    const action = mod.created ? 'Created' : 'Committed to'
    const pushed = mod.pushed
      ? `pushed to \`${report.remote}\``
      : report.remote === null
        ? 'not pushed — no remote is configured'
        : 'not pushed'
    lines.push(
      `${action} \`${mod.target}\` as \`${short(mod.commit)}\`, ${pushed}. ` +
      `Payload: ${count(mod.fileCount)}, ${formatBytes(mod.totalBytes)}.`,
      ''
    )
  }

  if (mod.excluded.length > 0) {
    lines.push(`<details><summary>Excluded ${count(mod.excluded.length)}</summary>`, '')
    lines.push(`These files matched an ignore rule in \`${report.configPath}\` and were not published.`, '')
    lines.push('| Path | Rule |', '| --- | --- |')
    for (const file of mod.excluded) {
      lines.push(`| \`${file.path}\` | \`${file.rule}\` |`)
    }
    lines.push('', '</details>', '')
  }

  return lines
}

const short = (sha) => (sha === null ? '' : sha.slice(0, 7))
const count = (n) => `${n} file${n === 1 ? '' : 's'}`

// Decimal units, matching how file sizes are quoted everywhere a mod author will see them.
//
// The escalation check compares the *rounded* (displayed) value against 1000, not the raw
// value: toFixed(1) can round e.g. 999.9999 up to "1000.0", and without this check that would
// print as "1000.0 kB" instead of escalating to "1.0 MB".
function formatBytes (bytes) {
  if (bytes < 1000) return `${bytes} B`
  const units = ['kB', 'MB', 'GB']
  let value = bytes / 1000
  let unit = 0
  while (Number(value.toFixed(1)) >= 1000 && unit < units.length - 1) {
    value /= 1000
    unit++
  }
  return `${value.toFixed(1)} ${units[unit]}`
}
