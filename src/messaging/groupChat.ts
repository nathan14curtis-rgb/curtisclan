import { getHousehold, setGroupChatId } from "../db/households";
import { listVerifiedUsersForHousehold } from "../db/users";
import { getSendblueConfig } from "../lib/secrets";
import { sendGroupMessage } from "../sendblue/client";
import type { Env } from "../types";

/**
 * The single send path for every household-facing message — clarification
 * questions, batch-resolution confirmations, and "fix" replies all go to
 * one shared iMessage group thread instead of whichever person owns the
 * card (per the household's request: route everything to a group chat
 * with both spouses). Creates the Sendblue group on first use and
 * persists its group_id so every later message lands in the same thread.
 */
export async function sendToHouseholdGroup(env: Env, householdId: string, content: string): Promise<{ messageHandle: string | null }> {
  const household = await getHousehold(env.DB, householdId);
  const config = getSendblueConfig(env);

  if (household.group_chat_id) {
    const response = await sendGroupMessage(config, { groupId: household.group_chat_id, content });
    return { messageHandle: response.message_handle };
  }

  const numbers = (await listVerifiedUsersForHousehold(env.DB, householdId))
    .map((u) => u.phone_e164)
    .filter((phone): phone is string => phone !== null);
  if (numbers.length === 0) return { messageHandle: null }; // nobody verified yet — nothing to send to

  const response = await sendGroupMessage(config, { numbers, content });
  await setGroupChatId(env.DB, householdId, response.group_id);
  return { messageHandle: response.message_handle };
}
