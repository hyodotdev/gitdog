const ACTION_TYPE_LABELS: Record<string, string> = {
  review: "tickets.actionTypes.review",
  format: "tickets.actionTypes.format",
  answer: "tickets.actionTypes.answer",
  tag_maintainers: "tickets.actionTypes.tagMaintainers",
  follow_up: "tickets.actionTypes.followUp",
};

/** The translation key naming a ticket action type, if it has one. */
export function actionTypeLabelKey(actionType: string): string | undefined {
  return ACTION_TYPE_LABELS[actionType];
}
