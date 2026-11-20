const ACTION_TYPE_LABELS: Record<string, string> = {
  review: "tickets.actionTypes.review",
  format: "tickets.actionTypes.format",
  answer: "tickets.actionTypes.answer",
  tag_maintainers: "tickets.actionTypes.tagMaintainers",
  follow_up: "tickets.actionTypes.followUp",
};

/** A ticket action type's name, or the raw type when it has no label. */
export function actionTypeLabel(
  t: (key: string) => string,
  actionType: string,
): string {
  const key = ACTION_TYPE_LABELS[actionType];
  return key ? t(key) : actionType;
}
