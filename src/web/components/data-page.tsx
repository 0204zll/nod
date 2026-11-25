import { useMemo, useState } from 'react';
import { chartVisual, parseDataPage, type DataTable } from '../../shared/data-page';
import { PresentationChart } from './presentation-chart';
import { Button } from './ui';
import { Download } from './icons';

type Cell = DataTable['rows'][number][string];

const cellText = (value: Cell | undefined) =>
  value === null || value === undefined
    ? ''
    : typeof value === 'object'
      ? value.text
      : String(value);

function csv(table: DataTable) {
  const quote = (value: string) => {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  return [
    table.columns.map((column) =>
      quote(column.unit ? `${column.label} (${column.unit})` : column.label),
    ),
    ...table.rows.map((row) => table.columns.map((column) => quote(cellText(row[column.key])))),
  ]
    .map((line) => line.join(','))
    .join('\r\n');
}

function save(table: DataTable) {
  const url = URL.createObjectURL(new Blob([`﻿${csv(table)}`], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${table.title.replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'table'}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function Table({ table }: { table: DataTable }) {
  const [sort, setSort] = useState<{ key: string; down: boolean } | null>(null);
  const number = useMemo(() => new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }), []);
  const rows = useMemo(() => {
    if (!sort) return table.rows;
    const value = (row: DataTable['rows'][number]) => {
      const cell = row[sort.key];
      return typeof cell === 'number' ? cell : cellText(cell).toLocaleLowerCase();
    };
    return [...table.rows].sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      const order =
        typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y));
      return sort.down ? -order : order;
    });
  }, [table.rows, sort]);
  return (
    <section className="data-block">
      <header className="data-block-heading">
        <h3>{table.title}</h3>
        <Button variant="ghost" onClick={() => save(table)}>
          <Download size={16} />
          Download CSV
        </Button>
      </header>
      <div className="data-table-scroll">
        <table className="data-table">
          <thead>
            <tr>
              {table.columns.map((column) => (
                <th
                  key={column.key}
                  className={column.kind === 'number' ? 'is-number' : undefined}
                  aria-sort={
                    sort?.key === column.key ? (sort.down ? 'descending' : 'ascending') : 'none'
                  }
                >
                  <button
                    type="button"
                    onClick={() =>
                      setSort(
                        sort?.key !== column.key
                          ? { key: column.key, down: column.kind === 'number' }
                          : sort.down === (column.kind === 'number')
                            ? { key: column.key, down: !sort.down }
                            : null,
                      )
                    }
                  >
                    {column.label}
                    {column.unit ? ` (${column.unit})` : ''}
                    {sort?.key === column.key ? (sort.down ? ' ↓' : ' ↑') : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={index}>
                {table.columns.map((column) => {
                  const value = row[column.key];
                  return (
                    <td
                      key={column.key}
                      className={column.kind === 'number' ? 'is-number' : undefined}
                    >
                      {value === null || value === undefined ? (
                        <span className="data-missing">Not stated</span>
                      ) : typeof value === 'object' ? (
                        <span className={`data-status is-${value.status}`}>{value.text}</span>
                      ) : typeof value === 'number' ? (
                        number.format(value)
                      ) : (
                        value
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {table.note && <p className="data-note">{table.note}</p>}
    </section>
  );
}

export function DataPageView({ text, fallback }: { text: string; fallback: React.ReactNode }) {
  const parsed = useMemo(() => parseDataPage(text), [text]);
  if ('error' in parsed) return <>{fallback}</>;
  const { page } = parsed;
  return (
    <div className="data-page-scroll">
      <article className="data-page">
        <header className="data-page-heading">
          <h2>{page.title}</h2>
          {page.summary && <p className="data-page-summary">{page.summary}</p>}
          <p className="data-page-source">
            Source: {page.source} · Read {page.readAt}
          </p>
        </header>
        {page.blocks.map((block, index) =>
          block.type === 'figures' ? (
            <section className="data-figures" key={index}>
              {block.items.map((item, position) => (
                <div className="data-figure" key={position}>
                  <span className="data-figure-label">{item.label}</span>
                  <strong className={item.status ? `is-${item.status}` : undefined}>
                    {item.value}
                  </strong>
                  {item.detail && <span className="data-figure-detail">{item.detail}</span>}
                </div>
              ))}
            </section>
          ) : block.type === 'chart' ? (
            <section className="data-block" key={index}>
              <header className="data-block-heading">
                <h3>{block.title}</h3>
              </header>
              <PresentationChart visual={chartVisual(block)} />
              {block.note && <p className="data-note">{block.note}</p>}
            </section>
          ) : block.type === 'table' ? (
            <Table table={block} key={index} />
          ) : (
            <section
              className={`data-callout${block.status ? ` is-${block.status}` : ''}`}
              key={index}
            >
              {block.title && <h3>{block.title}</h3>}
              <p>{block.text}</p>
            </section>
          ),
        )}
      </article>
    </div>
  );
}
