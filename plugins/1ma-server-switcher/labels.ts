export type Choice = { id: string; name: string; active: boolean };

function shortLabel(name: string): string {
  if (/linux/i.test(name)) return "Linux";
  if (/mac/i.test(name)) return "Mac";
  return name;
}

// "Linux" and "Mac" stand for the saved servers' names while they tell the
// servers apart; two servers that shorten alike keep their full names.
export function optionLabel(choices: readonly Choice[], choice: Choice): string {
  const short = shortLabel(choice.name);
  const shared = choices.filter((other) => shortLabel(other.name) === short).length > 1;
  return shared ? choice.name : short;
}
