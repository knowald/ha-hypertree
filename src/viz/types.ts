import type { TreeNode } from "../tree/types";
import type { HaState } from "../ha/types";

export interface Visualization {
  name: string;
  create(container: HTMLElement, root: TreeNode, states: Map<string, HaState>): void;
  destroy(): void;
  updateStates(states: Map<string, HaState>): void;
  onEntityChanged?(entityId: string, oldValue?: string): void;
}
