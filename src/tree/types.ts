export type NodeKind = "root" | "area" | "domain" | "device" | "entity";

export interface TreeNode {
  id: string;
  label: string;
  kind: NodeKind;
  domain?: string;
  entityId?: string;

  children: TreeNode[];
  parent: TreeNode | null;

  leafCount: number;
}
