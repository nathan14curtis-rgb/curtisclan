import { categorizeTransaction } from "../categorization/pipeline";
import { getInboundMessage, markInboundMessageProcessed } from "../db/inboundMessages";
import { describeError } from "../lib/errors";
import { sendDailyDigest } from "../messaging/dailyDigest";
import { processInboundReply } from "../messaging/inboundProcessing";
import { processSendClarification } from "../messaging/sendClarification";
import { handleItemWebhook, syncPlaidItem } from "../plaid/sync";
import type { MessageQueueMessage, TransactionQueueMessage } from "../lib/queueMessages";
import type { Env } from "../types";

const MESSAGE_QUEUE_NAME = "curtisclan-messages";

/** One handler for both bound queues (PLAN.md §2 gotcha #2 territory —
 * batches must stay small/fast per invocation), branching on batch.queue.
 * Each message is acked or retried individually so one bad job doesn't
 * block the rest of its batch. */
export async function handleQueueBatch(batch: MessageBatch<TransactionQueueMessage | MessageQueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (batch.queue === MESSAGE_QUEUE_NAME) {
        await handleMessageQueueMessage(message.body as MessageQueueMessage, env);
      } else {
        await handleTransactionQueueMessage(message.body as TransactionQueueMessage, env);
      }
      message.ack();
    } catch (err) {
      const jobType = message.body && (message.body as { type?: string }).type;
      console.error(`queue job failed (${batch.queue}, ${jobType}): ${describeError(err)}`);
      message.retry();
    }
  }
}

async function handleTransactionQueueMessage(msg: TransactionQueueMessage, env: Env): Promise<void> {
  console.log(`[queue] transaction: ${msg.type}`, msg);
  switch (msg.type) {
    case "plaid_sync":
      await syncPlaidItem(env, msg.householdId, msg.plaidItemId);
      return;
    case "item_webhook":
      await handleItemWebhook(env, msg.householdId, msg.plaidItemId, msg.webhookCode);
      return;
    case "categorize":
      await categorizeTransaction(env, msg.householdId, msg.transactionId, { skipClarification: msg.skipClarification });
      return;
    case "resolve_reply": {
      const inbound = await getInboundMessage(env.DB, msg.inboundMessageId);
      if (!inbound) return;
      await processInboundReply(env, msg.householdId, msg.userId, inbound.content);
      await markInboundMessageProcessed(env.DB, inbound.id);
      return;
    }
  }
}

async function handleMessageQueueMessage(msg: MessageQueueMessage, env: Env): Promise<void> {
  console.log(`[queue] message: ${msg.type}`, msg);
  switch (msg.type) {
    case "send_clarification":
      await processSendClarification(env, msg.householdId, msg.clarificationId, async (delaySeconds) => {
        await env.MESSAGE_QUEUE.send(msg, { delaySeconds });
      });
      return;
    case "daily_digest":
      await sendDailyDigest(env, msg.householdId);
      return;
  }
}
