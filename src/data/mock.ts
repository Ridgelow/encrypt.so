export type ChatPreview = {
  id: string;
  name: string;
  initials?: string;
  group?: boolean;
  preview: string;
  time: string;
  unread?: number;
  locked?: boolean;
  disappearing?: boolean;
};

export type Contact = {
  id: string;
  name: string;
  initials: string;
  /** Auth user id. Mock contacts omit this and stay on the local thread. */
  userId?: string;
};

export type Message =
  | { id: string; kind: "system"; text: string }
  | {
      id: string;
      kind: "text";
      from: "me" | "them";
      text: string;
      time?: string;
      receipts?: string;
      sender?: string;
      senderInitials?: string;
      /** Unix milliseconds. The bubble is removed locally when this time passes. */
      expireAt?: number | null;
    }
  | { id: string; kind: "image"; from: "me" | "them"; time?: string; receipts?: string }
  | { id: string; kind: "file"; from: "me" | "them"; name: string; size: string; time?: string };

export const chats: ChatPreview[] = [
  {
    id: "sam",
    name: "Sam",
    initials: "SR",
    preview: "Sounds good, see you then",
    time: "9:41",
    unread: 2,
  },
  {
    id: "design-crit",
    name: "Design Crit",
    group: true,
    preview: "Priya: pushed the new mocks",
    time: "9:12",
  },
  {
    id: "alex",
    name: "Alex Chen",
    initials: "AC",
    preview: "🔒 New safety number",
    time: "Yesterday",
    locked: true,
  },
  {
    id: "jordan",
    name: "Jordan",
    initials: "JR",
    preview: "Can you send the file over?",
    time: "Yesterday",
  },
  {
    id: "hackrice",
    name: "HackRice Team",
    group: true,
    preview: "Mira: pulling an all-nighter",
    time: "Mon",
    unread: 5,
  },
  {
    id: "taylor",
    name: "Taylor",
    initials: "TK",
    preview: "Disappearing messages is on",
    time: "Mon",
    disappearing: true,
  },
];

export const contacts: Contact[] = [
  { id: "alex", name: "Alex Chen", initials: "AC" },
  { id: "jordan", name: "Jordan Reyes", initials: "JR" },
  { id: "mira", name: "Mira Patel", initials: "MP" },
  { id: "sam", name: "Sam Rivera", initials: "SR" },
  { id: "taylor", name: "Taylor Kim", initials: "TK" },
];

export const samThread: Message[] = [
  { id: "b1", kind: "system", text: "Messages are end-to-end encrypted" },
  {
    id: "m1",
    kind: "text",
    from: "them",
    text: "Hey! Did you get a chance to look at the draft?",
    time: "9:32",
  },
  {
    id: "m2",
    kind: "text",
    from: "me",
    text: "Yeah, just finished — looks great",
    time: "9:34",
    receipts: "✓✓",
  },
  { id: "m3", kind: "image", from: "me", time: "9:35", receipts: "✓✓" },
  {
    id: "m4",
    kind: "text",
    from: "them",
    text: "Perfect, that's exactly what I meant",
    time: "9:36",
  },
  {
    id: "m5",
    kind: "file",
    from: "them",
    name: "contract_v2.pdf",
    size: "244 KB",
  },
  { id: "s1", kind: "system", text: "— Disappearing messages: 1 week —" },
  {
    id: "m6",
    kind: "text",
    from: "me",
    text: "Sounds good, see you then",
    time: "9:41",
    receipts: "✓",
  },
];

export const groupThread: Message[] = [
  { id: "b1", kind: "system", text: "Messages are end-to-end encrypted" },
  { id: "s1", kind: "system", text: "— Mira added Sam to the group —" },
  {
    id: "m1",
    kind: "text",
    from: "them",
    sender: "Priya",
    senderInitials: "PS",
    text: "Anyone free to pair on the backend tonight?",
  },
  {
    id: "m2",
    kind: "text",
    from: "them",
    sender: "Mira",
    senderInitials: "MP",
    text: "I'm in after 8",
  },
  { id: "m3", kind: "text", from: "me", text: "Same, ping me" },
  {
    id: "m4",
    kind: "file",
    from: "them",
    name: "api-notes.md",
    size: "12 KB",
  },
  { id: "s2", kind: "system", text: "— Disappearing messages: 1 day —" },
  {
    id: "m5",
    kind: "text",
    from: "me",
    text: "Pushed the new mocks, take a look",
  },
];

export const safetyDigits = [
  "47281",
  "93017",
  "28461",
  "50194",
  "77302",
  "14829",
  "66120",
  "39485",
];
