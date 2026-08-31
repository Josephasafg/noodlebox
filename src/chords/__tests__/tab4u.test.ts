import { describe, expect, it } from 'vitest'
import { parseTab4u } from '../tab4u'
import { sheetHasWords, sheetStats } from '../types'

const URL = 'https://www.tab4u.com/tabs/songs/66169_song.html'

/**
 * A trimmed tab4u song page, shaped exactly like the generated ones: tables of
 * single-cell rows classed `song`, `chords` and `tabs`. The words are
 * placeholders — what is under test is the alignment and the markup, not any
 * particular song.
 */
const PAGE = `
<html><head><title>אקורדים לשיר שיר לדוגמה - נגן לדוגמה | Tab4U</title></head>
<body><div id="songContentTPL" align="right">
<table border="0"><tbody>
\t<tr><td class="song">
\t\tפתיחה:
\t</td></tr>
</tbody></table>
<br /><table border="0"><tbody>
\t<tr><td class="tabs">
\t\tE|------|
\t</td></tr>
\t<tr><td class="tabs">
\t\tB|------|
\t</td></tr>
\t<tr><td class="tabs">
\t\tG|4s5-5-|
\t</td></tr>
\t<tr><td class="tabs">
\t\tD|3s4-4-|
\t</td></tr>
\t<tr><td class="tabs">
\t\tA|------|
\t</td></tr>
\t<tr><td class="tabs">
\t\tE|------|
\t</td></tr>
\t<tr><td class="song">
\t\tx4
\t</td></tr>
</tbody></table>
<br /><table border="0"><tbody>
\t<tr><td class="chords">
\t\t<span onmouseover="sCI('A7','S5F0E0\`S4F2E1\`S3F0E0\`S2F2E3\`S1F0E0^S6F5E1\`S5F7E3\`S4F5E1\`S3F6E2\`S2F8E4\`S1F5E1',1,'',1,1);" onmouseout='CO()' id="c_1" class="c_C">A7</span>&nbsp;&nbsp;<span onmouseover="sCI('G7','S6F3E3\`S5F2E2\`S4F0E0\`S3F0E0\`S2F0E0\`S1F1E1',1,'',1,2);" onmouseout='CO()' id="c_2" class="c_C">G7</span>&nbsp;&nbsp;&nbsp;
\t</td></tr>
\t<tr><td class="song">
\t\tמילה&nbsp;אחת&nbsp;ועוד&nbsp;אחת&nbsp;&nbsp;
\t</td></tr>
\t<tr><td class="chords">
\t\t<span onmouseover="sCI('E','S6F0E0\`S5F2E2\`S4F2E3\`S3F1E1\`S2F0E0\`S1F0E0',1,'',1,3);" onmouseout='CO()' id="c_3" class="c_C">E</span>
\t</td></tr>
</tbody></table>
</div>
<div id="ratingWrap"><table><tbody><tr><td class="song">לא חלק מהשיר</td></tr></tbody></table></div>
</body></html>
`

const page = parseTab4u(PAGE, URL)
const { sheet, score } = page

describe('parseTab4u', () => {
  it('reads the song and artist off the page title', () => {
    expect(sheet.title).toBe('שיר לדוגמה')
    expect(sheet.artist).toBe('נגן לדוגמה')
    expect(sheet.sourceUrl).toBe(URL)
  })

  it('reads Hebrew words as a right-to-left sheet', () => {
    expect(sheet.rtl).toBe(true)
    expect(sheetHasWords(sheet)).toBe(true)
  })

  it('anchors each chord to the column its name starts on', () => {
    const line = sheet.blocks[0].lines[0]
    expect(line).toEqual({
      kind: 'lyrics',
      text: 'מילה אחת ועוד אחת',
      // A7 spans columns 0-1, then two spaces, so G7 lands on column 4.
      chords: [
        { name: 'A7', column: 0 },
        { name: 'G7', column: 4 },
      ],
    })
  })

  it('keeps a chords row with no words under it as a chord run', () => {
    expect(sheet.blocks[0].lines[1]).toEqual({
      kind: 'chords',
      chords: [{ name: 'E', column: 0 }],
    })
  })

  it('reads fingerings with strings counted from the low E', () => {
    // A7 is x02020: the low E is left out of the data, so it is not played.
    expect(sheet.shapes.A7).toHaveLength(2)
    expect(sheet.shapes.A7[0].frets).toEqual([null, 0, 2, 0, 2, 0])
    expect(sheet.shapes.A7[1].frets).toEqual([5, 7, 5, 6, 8, 5])
    expect(sheet.shapes.G7[0].frets).toEqual([3, 2, 0, 0, 0, 1])
  })

  it('ignores tables outside the song content', () => {
    const texts = sheet.blocks.flatMap((b) =>
      b.lines.flatMap((l) => (l.kind === 'lyrics' ? [l.text] : [])),
    )
    expect(texts).not.toContain('לא חלק מהשיר')
  })

  it('counts what the list row shows', () => {
    expect(sheetStats(sheet)).toEqual({ lines: 1, chords: 3 })
  })

  it('refuses a page with no song content on it', () => {
    expect(() => parseTab4u('<html><body>nothing</body></html>', URL)).toThrow(/tab4u/)
  })
})

describe('the tablature on a tab4u page', () => {
  it('is engraved as a score rather than kept as text', () => {
    expect(score).not.toBeNull()
    expect(score?.title).toBe('שיר לדוגמה')
    expect(page.blocks).toHaveLength(1)
    // No sheet line holds tablature any more; it all becomes the score.
    const kinds = sheet.blocks.flatMap((b) => b.lines.map((l) => l.kind))
    expect(kinds).not.toContain('tab')
  })

  it('reads the frets and the slides off the staff', () => {
    const first = (score?.notes ?? []).filter((n) => n.measureIndex === 0)
    // `4s5-5-` on two strings at once: a double stop sliding up, then struck
    // again. The slide lands on the note it arrives at, on both strings.
    expect(first.map((n) => [n.stringIdx, n.fret, n.art])).toEqual([
      [3, 4, undefined],
      [2, 3, undefined],
      [3, 5, 'slide-up'],
      [2, 4, 'slide-up'],
      [3, 5, undefined],
      [2, 4, undefined],
    ])
  })

  it('folds a repeat printed beside a staff into its section name', () => {
    // The engraved bars have nowhere else to say `x4`, and losing it would lose
    // how long the intro runs.
    expect(score?.measures[0].marker).toBe('פתיחה ×4')
  })

  it('drops the table that only labelled the staff from the sheet', () => {
    // The label became the score's section name, so leaving it in the sheet
    // would show a heading with nothing under it.
    expect(sheet.blocks).toHaveLength(1)
  })
})
