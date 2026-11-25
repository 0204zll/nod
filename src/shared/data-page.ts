import { z } from 'zod';
import { presentationSchema, type Presentation } from './presentation.ts';

export const dataPageMimeType = 'application/vnd.nod.data+json';
export const dataPageName = /\.data\.json$/i;

const text = (length: number) =>
  z
    .string()
    .min(1)
    .max(length)
    .refine((value) => Boolean(value.trim()));
const status = z.enum(['good', 'warn', 'bad']);
const cell = z.union([
  z.string().max(400),
  z.number().finite(),
  z.null(),
  z.strictObject({ status, text: text(60) }),
]);
const figures = z.strictObject({
  type: z.literal('figures'),
  items: z
    .array(
      z.strictObject({
        label: text(80),
        value: text(40),
        detail: text(200).optional(),
        status: status.optional(),
      }),
    )
    .min(1)
    .max(6),
});
const chart = z.strictObject({
  type: z.literal('chart'),
  title: text(120),
  chart: z.enum(['bar', 'line']),
  unit: text(32).optional(),
  xLabel: text(80).optional(),
  yLabel: text(80).optional(),
  note: text(600).optional(),
  series: z
    .array(
      z.strictObject({
        label: text(120),
        points: z
          .array(
            z.strictObject({ label: text(80), value: z.number().finite().min(-1e12).max(1e12) }),
          )
          .min(1)
          .max(24),
      }),
    )
    .min(1)
    .max(3),
});
const table = z.strictObject({
  type: z.literal('table'),
  title: text(120),
  note: text(600).optional(),
  columns: z
    .array(
      z.strictObject({
        key: text(40).regex(/^[A-Za-z0-9_-]+$/),
        label: text(80),
        kind: z.enum(['text', 'number', 'status']).default('text'),
        unit: text(32).optional(),
      }),
    )
    .min(1)
    .max(12),
  rows: z.array(z.record(z.string(), cell)).max(500),
});
const note = z.strictObject({
  type: z.literal('note'),
  title: text(120).optional(),
  text: text(1200),
  status: status.optional(),
});

export type DataChart = z.infer<typeof chart>;

export function chartVisual(block: DataChart): Extract<Presentation, { type: 'chart' }> {
  return {
    version: 1,
    type: 'chart',
    title: block.title,
    sources: [],
    chart: block.chart,
    ...(block.unit ? { unit: block.unit } : {}),
    ...(block.xLabel ? { xLabel: block.xLabel } : {}),
    ...(block.yLabel ? { yLabel: block.yLabel } : {}),
    series: block.series.map((series, index) => ({ id: `s${index + 1}`, ...series })),
  };
}

export const dataPageSchema = z
  .strictObject({
    version: z.literal(1),
    title: text(120),
    summary: text(400).optional(),
    source: text(200),
    readAt: text(80),
    blocks: z
      .array(z.discriminatedUnion('type', [figures, chart, table, note]))
      .min(1)
      .max(16),
  })
  .superRefine((page, context) => {
    page.blocks.forEach((block, index) => {
      const invalid = (message: string) =>
        context.addIssue({ code: 'custom', path: ['blocks', index], message });
      if (block.type === 'chart') {
        const checked = presentationSchema.safeParse(chartVisual(block));
        if (!checked.success) invalid(checked.error.issues[0]?.message ?? 'The chart is invalid.');
      }
      if (block.type !== 'table') return;
      const kinds = new Map(block.columns.map((column) => [column.key, column.kind]));
      if (kinds.size !== block.columns.length) invalid('Each table column needs its own key.');
      block.rows.forEach((row, rowIndex) => {
        for (const [key, value] of Object.entries(row)) {
          const kind = kinds.get(key);
          const structured = typeof value === 'object' && value !== null;
          if (!kind) invalid(`Row ${rowIndex + 1} has the unknown column ${key}.`);
          else if (kind === 'number' && value !== null && typeof value !== 'number')
            invalid(`Row ${rowIndex + 1}, column ${key} must be a number or null.`);
          else if (kind === 'status' && value !== null && !structured)
            invalid(`Row ${rowIndex + 1}, column ${key} must be {status,text} or null.`);
          else if (kind !== 'status' && structured)
            invalid(`Row ${rowIndex + 1}, column ${key} is not a status column.`);
        }
      });
    });
  });

export type DataPage = z.infer<typeof dataPageSchema>;
export type DataBlock = DataPage['blocks'][number];
export type DataTable = Extract<DataBlock, { type: 'table' }>;

export function parseDataPage(source: string): { page: DataPage } | { error: string } {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return { error: 'The data page is not valid JSON.' };
  }
  const parsed = dataPageSchema.safeParse(value);
  if (parsed.success) return { page: parsed.data };
  return {
    error: `The data page is invalid: ${parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || 'page'}: ${issue.message}`)
      .join('; ')}`,
  };
}
