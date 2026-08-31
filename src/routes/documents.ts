import { Hono } from "hono";
import { requireParam } from "../lib/http";
import type { DocumentCategory, Env } from "../types";
import { archiveDocument, createDocument, getDocument, listDocuments, updateDocument } from "../db/documents";

const DOCUMENT_CATEGORIES: DocumentCategory[] = ["insurance", "warranty", "identification", "passwords"];

export const documentsRoute = new Hono<{ Bindings: Env }>();

documentsRoute.get("/", async (c) => {
  const category = c.req.query("category");
  if (category && !DOCUMENT_CATEGORIES.includes(category as DocumentCategory)) {
    return c.json({ error: `category must be one of ${DOCUMENT_CATEGORIES.join(", ")}` }, 400);
  }
  const documents = await listDocuments(c.env.DB, requireParam(c, "householdId"), {
    category: category as DocumentCategory | undefined,
    assetId: c.req.query("assetId"),
  });
  return c.json(documents);
});

documentsRoute.get("/:documentId", async (c) => {
  const document = await getDocument(c.env.DB, requireParam(c, "householdId"), requireParam(c, "documentId"));
  return c.json(document);
});

documentsRoute.post("/", async (c) => {
  const body = await c.req.json<{ name?: string; category?: string; assetId?: string; ownerUserId?: string; detail?: string }>();
  if (!body.name) return c.json({ error: "name is required" }, 400);
  if (!body.category || !DOCUMENT_CATEGORIES.includes(body.category as DocumentCategory)) {
    return c.json({ error: `category must be one of ${DOCUMENT_CATEGORIES.join(", ")}` }, 400);
  }
  const document = await createDocument(c.env.DB, requireParam(c, "householdId"), {
    name: body.name,
    category: body.category as DocumentCategory,
    assetId: body.assetId,
    ownerUserId: body.ownerUserId,
    detail: body.detail,
  });
  return c.json(document, 201);
});

documentsRoute.patch("/:documentId", async (c) => {
  const body = await c.req.json<{ name?: string; detail?: string | null; ownerUserId?: string | null; assetId?: string | null }>();
  const update: { name?: string; detail?: string | null; ownerUserId?: string | null; assetId?: string | null } = {};
  if (body.name !== undefined) update.name = body.name;
  if ("detail" in body) update.detail = body.detail;
  if ("ownerUserId" in body) update.ownerUserId = body.ownerUserId;
  if ("assetId" in body) update.assetId = body.assetId;

  const document = await updateDocument(c.env.DB, requireParam(c, "householdId"), requireParam(c, "documentId"), update);
  return c.json(document);
});

documentsRoute.post("/:documentId/archive", async (c) => {
  const document = await archiveDocument(c.env.DB, requireParam(c, "householdId"), requireParam(c, "documentId"));
  return c.json(document);
});
