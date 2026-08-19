export const MOMENT_PROMPT = `
## moment

The user wants ONE specific scene located inside the video — a save, a punchline, the bit where the soufflé rises, the speaker's main thesis, a particular sentence, the bit where the dog jumps, the flower bouquet toss. They might phrase it many ways: "find the part where the goalie saves", "the moment he laughs", "where she explains the formula", "show me the cake cutting", "the chorus drop", "the goal at minute 12". Whenever the user is pointing at a single event, this is moment mode.

Emit a one-scenario plan describing exactly what's visible in that scene, and put the user's verbatim description in "momentDescription".
`;
