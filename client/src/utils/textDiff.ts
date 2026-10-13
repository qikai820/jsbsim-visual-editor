export type DiffKind = 'same' | 'removed' | 'added' | 'changed' | 'empty';
export type DiffSide = { text: string; number: number | null; kind: DiffKind };
export type DiffRow = { left: DiffSide; right: DiffSide; changed: boolean };
export type TextDiff = {
  rows: DiffRow[];
  changeStarts: number[];
  additions: number;
  deletions: number;
  approximate: boolean;
  finalNewlineDiffers: boolean;
  lineEndingDiffers: boolean;
};

function splitLines(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n');
  if (!normalized) return [];
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) lines.pop();
  return lines;
}

function lineKey(line: string, ignoreWhitespace: boolean): string {
  return ignoreWhitespace ? line.replace(/\s+/g, '') : line;
}

export function diffText(local: string, remote: string, ignoreWhitespace = false): TextDiff {
  const left = splitLines(local);
  const right = splitLines(remote);
  const leftKeys = left.map(line => lineKey(line, ignoreWhitespace));
  const rightKeys = right.map(line => lineKey(line, ignoreWhitespace));
  const rows: DiffRow[] = [];
  let additions = 0;
  let deletions = 0;
  const addPair = (leftIndex: number | null, rightIndex: number | null, same = false) => {
    const changed = !same;
    rows.push({
      left: { text: leftIndex === null ? '' : left[leftIndex], number: leftIndex === null ? null : leftIndex + 1,
        kind: leftIndex === null ? 'empty' : same ? 'same' : rightIndex === null ? 'removed' : 'changed' },
      right: { text: rightIndex === null ? '' : right[rightIndex], number: rightIndex === null ? null : rightIndex + 1,
        kind: rightIndex === null ? 'empty' : same ? 'same' : leftIndex === null ? 'added' : 'changed' },
      changed,
    });
    if (changed) {
      if (leftIndex !== null) deletions += 1;
      if (rightIndex !== null) additions += 1;
    }
  };

  const size = left.length * right.length;
  const approximate = size > 2_000_000;
  if (approximate) {
    // Keep memory bounded for very large XML sources. The UI reports this
    // fallback explicitly, since shifted lines can appear as replacements.
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const li = index < left.length ? index : null;
      const ri = index < right.length ? index : null;
      addPair(li, ri, li !== null && ri !== null && leftKeys[li] === rightKeys[ri]);
    }
  } else {
    const columns = right.length + 1;
    const lengths = new Uint32Array((left.length + 1) * columns);
    for (let i = left.length - 1; i >= 0; i -= 1) {
      for (let j = right.length - 1; j >= 0; j -= 1) {
        lengths[i * columns + j] = leftKeys[i] === rightKeys[j]
          ? 1 + lengths[(i + 1) * columns + j + 1]
          : Math.max(lengths[(i + 1) * columns + j], lengths[i * columns + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < left.length || j < right.length) {
      if (i < left.length && j < right.length && leftKeys[i] === rightKeys[j]) {
        addPair(i, j, true);
        i += 1;
        j += 1;
        continue;
      }
      const removed: number[] = [];
      const added: number[] = [];
      while ((i < left.length || j < right.length) &&
             !(i < left.length && j < right.length && leftKeys[i] === rightKeys[j])) {
        if (i < left.length && (j === right.length || lengths[(i + 1) * columns + j] >= lengths[i * columns + j + 1])) {
          removed.push(i++);
        } else {
          added.push(j++);
        }
      }
      for (let index = 0; index < Math.max(removed.length, added.length); index += 1) {
        addPair(removed[index] ?? null, added[index] ?? null);
      }
    }
  }

  const finalNewlineDiffers = local.replace(/\r\n?/g, '\n').endsWith('\n') !==
    remote.replace(/\r\n?/g, '\n').endsWith('\n');
  const lineEndingDiffers = /\r\n/.test(local) !== /\r\n/.test(remote);
  const changeStarts = rows.flatMap((row, index) => row.changed && !rows[index - 1]?.changed ? [index] : []);
  return { rows, changeStarts, additions, deletions, approximate, finalNewlineDiffers, lineEndingDiffers };
}

export function changedParts(left: string, right: string): [string, string, string, string] {
  let start = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start += 1;
  let end = 0;
  while (end < left.length - start && end < right.length - start &&
         left[left.length - end - 1] === right[right.length - end - 1]) end += 1;
  return [left.slice(0, start), left.slice(start, left.length - end),
    right.slice(start, right.length - end), end ? left.slice(left.length - end) : ''];
}
