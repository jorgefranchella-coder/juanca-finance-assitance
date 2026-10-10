import { sql } from "drizzle-orm";
import {
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const imports = sqliteTable(
  "imports",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    owner: text("owner").notNull(),
    fileType: text("file_type", { enum: ["positions", "movements", "avenue_statement", "avenue_confirmation", "pension_statement", "chat_transaction"] }).notNull(),
    fileName: text("file_name").notNull(),
    sha256: text("sha256").notNull(),
    referenceDate: text("reference_date"),
    objectKey: text("object_key").notNull(),
    recordCount: integer("record_count").notNull(),
    marketValueCents: integer("market_value_cents"),
    reviewRequired: integer("review_required").notNull().default(0),
    status: text("status").notNull().default("processed"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_imports_user_sha_type").on(
      table.userId,
      table.sha256,
      table.fileType,
    ),
    index("idx_imports_user_created").on(table.userId, table.createdAt),
  ],
);

export const importRecords = sqliteTable(
  "import_records",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    importId: text("import_id")
      .notNull()
      .references(() => imports.id, { onDelete: "cascade" }),
    recordKind: text("record_kind").notNull(),
    sourceSheet: text("source_sheet").notNull(),
    sourceRow: integer("source_row").notNull(),
    eventType: text("event_type"),
    requiresReview: integer("requires_review", { mode: "boolean" })
      .notNull()
      .default(false),
    payload: text("payload").notNull(),
  },
  (table) => [index("idx_import_records_import").on(table.importId)],
);

export const reviewDecisions = sqliteTable(
  "review_decisions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    importRecordId: integer("import_record_id")
      .notNull()
      .references(() => importRecords.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    decision: text("decision").notNull(),
    note: text("note"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    uniqueIndex("idx_review_decisions_user_record").on(
      table.userId,
      table.importRecordId,
    ),
  ],
);

export const costBasis = sqliteTable(
  "cost_basis",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(), owner: text("owner").notNull(),
    instrumentCode: text("instrument_code").notNull(), currency: text("currency").notNull(),
    quantity: real("quantity").notNull(), averageUnitCost: real("average_unit_cost").notNull(),
    asOf: text("as_of").notNull(), source: text("source").notNull().default("manual"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("idx_cost_basis_identity").on(table.userId, table.owner, table.instrumentCode, table.currency)],
);

export const marketQuotes = sqliteTable(
  "market_quotes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }), userId: text("user_id").notNull(),
    market: text("market").notNull(), symbol: text("symbol").notNull(), currency: text("currency").notNull(),
    price: real("price").notNull(), provider: text("provider").notNull(), quotedAt: text("quoted_at").notNull(),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [uniqueIndex("idx_market_quotes_identity").on(table.userId, table.market, table.symbol)],
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(), userId: text("user_id").notNull(), role: text("role").notNull(),
    content: text("content").notNull(), attachmentName: text("attachment_name"),
    attachmentType: text("attachment_type"), objectKey: text("object_key"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_chat_messages_user_created").on(table.userId, table.createdAt)],
);

export const transactionProposals = sqliteTable(
  "transaction_proposals",
  {
    sourceMessageId: text("source_message_id").references(() => chatMessages.id),
    id: text("id").primaryKey(), messageId: text("message_id").notNull().references(() => chatMessages.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(), owner: text("owner").notNull(), side: text("side").notNull(),
    instrumentCode: text("instrument_code").notNull(), quantity: real("quantity").notNull(),
    unitPrice: real("unit_price").notNull(), currency: text("currency").notNull(), tradeDate: text("trade_date").notNull(),
    feesMinor: integer("fees_minor").notNull().default(0), source: text("source").notNull(),
    confidence: real("confidence").notNull(), evidence: text("evidence").notNull(),
    status: text("status").notNull().default("pending"), appliedImportId: text("applied_import_id"),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [index("idx_transaction_proposals_user_status").on(table.userId, table.status, table.createdAt)],
);
