import type { BuildChatMessage, BuildChatState } from "@jarvis/contracts";
import type { TaskStore } from "../tasks/task-store.js";
import type { BuildChatStore } from "./build-chat-store.js";

const RUNNER_STALE_MS = 2 * 60_000;

/**
 * The server's side of Construir: it stores what the owner writes and shows the conversation
 * with the agent's progress. The agent itself runs in the agent runner (`BuildSession`).
 */
export class BuildChatService {
  constructor(
    private readonly store: BuildChatStore,
    private readonly tasks: TaskStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  view(): { messages: BuildChatMessage[]; state: BuildChatState } {
    const state = this.store.state();
    const beat = this.tasks.lastBeat();
    const alive = beat !== undefined && this.now().getTime() - Date.parse(beat) < RUNNER_STALE_MS;
    const publication = state.shipTaskId ? this.tasks.publication(state.shipTaskId) : undefined;
    const showPublication = publication && (publication.status === "queued" || publication.status === "running" || state.reportedTaskId !== state.shipTaskId);
    return {
      messages: this.store.messages().map((message) => ({ id: message.id, role: message.role === "owner" ? "owner" : "assistant", text: message.text, at: message.createdAt })),
      state: {
        status: alive ? state.status : "offline",
        ...(state.activity ? { activity: state.activity } : {}),
        steps: state.todos.map((todo) => ({ text: todo.status === "in_progress" ? (todo.activeForm ?? todo.content) : todo.content, status: todo.status })),
        ...(state.resumeAt ? { resumeAt: state.resumeAt } : {}),
        ...(showPublication && publication
          ? { publication: { status: publication.status, ...(publication.step ? { step: publication.step } : {}), title: publication.commitTitle.slice(0, 100) } }
          : {}),
      },
    };
  }

  request(text: string): void {
    this.store.post("owner", text, this.now());
  }

  stop(): void {
    if (this.store.state().status === "working") this.store.update({ stopRequested: true }, this.now());
  }
}
