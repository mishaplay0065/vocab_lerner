/**
 * csv.js
 * -----------------------------------------------------------------------
 * Small, dependency-free CSV parser + validator for vocabulary import.
 * Supports:
 *   - UTF-8 with or without a BOM
 *   - ";" (preferred) or "," as the delimiter (auto-detected from the header)
 *   - quoted fields, including embedded delimiters/newlines/escaped quotes ("")
 *   - an optional header row (term / translation / context, RU or EN names)
 *   - column order term;translation;context when there is no header
 * All error messages are Russian, meant to be shown directly to the user.
 * -----------------------------------------------------------------------
 */
(function (global) {

  const HEADER_ALIASES = {
    term: ['term', 'слово', 'термин', 'word', 'фраза'],
    translation: ['translation', 'перевод'],
    context: ['context', 'контекст', 'пример', 'example']
  };

  function stripBom(text) {
    if (text.charCodeAt(0) === 0xFEFF) return text.slice(1);
    return text;
  }

  // Splits raw CSV text into rows of raw field arrays, respecting quotes.
  function tokenize(text, delimiter) {
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    let i = 0;
    const n = text.length;

    while (i < n) {
      const c = text[i];

      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          inQuotes = false; i++; continue;
        }
        field += c; i++; continue;
      }

      if (c === '"') { inQuotes = true; i++; continue; }
      if (c === delimiter) { row.push(field); field = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') {
        row.push(field); field = '';
        rows.push(row); row = [];
        i++; continue;
      }
      field += c; i++;
    }
    // last field/row
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows.filter((r) => !(r.length === 1 && r[0].trim() === ''));
  }

  function detectDelimiter(firstLine) {
    const semi = (firstLine.match(/;/g) || []).length;
    const comma = (firstLine.match(/,/g) || []).length;
    return semi >= comma ? ';' : ',';
  }

  function matchHeaderIndex(headerCell) {
    const norm = headerCell.trim().toLowerCase();
    for (const key of Object.keys(HEADER_ALIASES)) {
      if (HEADER_ALIASES[key].includes(norm)) return key;
    }
    return null;
  }

  function looksLikeHeader(row) {
    return row.some((cell) => matchHeaderIndex(cell) !== null);
  }

  /**
   * Parses and validates raw CSV text.
   * @returns {{items: Array<{term:string, translation:string, context:string}>, errors: string[], warnings: string[]}}
   */
  function parseCsv(rawText) {
    const errors = [];
    const warnings = [];

    if (!rawText || !rawText.trim()) {
      return { items: [], errors: ['Файл пустой.'], warnings };
    }

    const text = stripBom(rawText).trim();
    const firstLine = text.split(/\r\n|\n/, 1)[0] || '';
    const delimiter = detectDelimiter(firstLine);

    let rows;
    try {
      rows = tokenize(text, delimiter);
    } catch (e) {
      return { items: [], errors: ['Не удалось прочитать файл. Проверьте кодировку (нужна UTF-8) и формат CSV.'], warnings };
    }

    if (rows.length === 0) {
      return { items: [], errors: ['В файле не найдено ни одной строки с данными.'], warnings };
    }

    let colMap = { term: 0, translation: 1, context: 2 };
    let dataRows = rows;
    let startLineNo = 1;

    if (looksLikeHeader(rows[0])) {
      const header = rows[0];
      const map = {};
      header.forEach((cell, idx) => {
        const key = matchHeaderIndex(cell);
        if (key) map[key] = idx;
      });
      if (map.term === undefined || map.translation === undefined) {
        errors.push('В заголовке файла не найдены обязательные столбцы «term» и «translation». Проверьте первую строку файла.');
        return { items: [], errors, warnings };
      }
      colMap = map;
      dataRows = rows.slice(1);
      startLineNo = 2;
    } else if ((rows[0].length < 2)) {
      errors.push('Не удалось определить столбцы. Убедитесь, что строки имеют вид term;translation;context.');
      return { items: [], errors, warnings };
    }

    const items = [];
    const seen = new Set();

    dataRows.forEach((row, idx) => {
      const lineNo = startLineNo + idx;
      if (row.length === 1 && row[0].trim() === '') return; // blank line

      const term = (row[colMap.term] || '').trim();
      const translation = (row[colMap.translation] || '').trim();
      const context = colMap.context !== undefined ? (row[colMap.context] || '').trim() : '';

      if (!term && !translation) return; // fully empty row, silently skip

      if (!term || !translation) {
        errors.push(`Строка ${lineNo}: не хватает поля «${!term ? 'term' : 'translation'}».`);
        return;
      }

      const dupKey = term.toLowerCase() + '␟' + translation.toLowerCase();
      if (seen.has(dupKey)) {
        warnings.push(`Строка ${lineNo}: дубликат «${term}» — пропущена.`);
        return;
      }
      seen.add(dupKey);

      items.push({ term, translation, context });
    });

    if (items.length === 0 && errors.length === 0) {
      errors.push('В файле не найдено ни одной корректной строки со словом и переводом.');
    }

    return { items, errors, warnings };
  }

  global.VocabCsv = { parseCsv };
})(window);
