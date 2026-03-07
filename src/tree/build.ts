import type { Registries } from "../ha/types";
import type { TreeNode } from "./types";

const UNASSIGNED_AREA = "Unassigned";

export function buildTree(registries: Registries): TreeNode {
  const { areas, devices, entities } = registries;

  const deviceAreaMap = new Map<string, string>();
  for (const device of devices) {
    if (device.area_id) {
      deviceAreaMap.set(device.id, device.area_id);
    }
  }

  const areaNameMap = new Map<string, string>();
  for (const area of areas) {
    areaNameMap.set(area.area_id, area.name);
  }

  const grouped = new Map<string, Map<string, typeof entities>>();

  for (const entity of entities) {
    if (entity.disabled_by) continue;

    let areaId =
      entity.area_id ??
      (entity.device_id ? deviceAreaMap.get(entity.device_id) ?? null : null);

    const areaKey = areaId ?? UNASSIGNED_AREA;
    const domain = entity.entity_id.split(".")[0];

    if (!grouped.has(areaKey)) {
      grouped.set(areaKey, new Map());
    }
    const domainMap = grouped.get(areaKey)!;
    if (!domainMap.has(domain)) {
      domainMap.set(domain, []);
    }
    domainMap.get(domain)!.push(entity);
  }

  const root: TreeNode = {
    id: "root",
    label: "Home",
    kind: "root",
    children: [],
    parent: null,
    leafCount: 0,

  };

  const sortedAreaKeys = [...grouped.keys()].sort((a, b) => {
    if (a === UNASSIGNED_AREA) return 1;
    if (b === UNASSIGNED_AREA) return -1;
    const nameA = areaNameMap.get(a) ?? a;
    const nameB = areaNameMap.get(b) ?? b;
    return nameA.localeCompare(nameB);
  });

  for (const areaKey of sortedAreaKeys) {
    const areaLabel =
      areaKey === UNASSIGNED_AREA ? UNASSIGNED_AREA : (areaNameMap.get(areaKey) ?? areaKey);

    const areaNode: TreeNode = {
      id: `area:${areaKey}`,
      label: areaLabel,
      kind: "area",
      children: [],
      parent: root,
      leafCount: 0,

    };

    const domainMap = grouped.get(areaKey)!;
    const sortedDomains = [...domainMap.keys()].sort();

    for (const domain of sortedDomains) {
      const domainEntities = domainMap.get(domain)!;

      const domainNode: TreeNode = {
        id: `domain:${areaKey}:${domain}`,
        label: domain,
        kind: "domain",
        domain,
        children: [],
        parent: areaNode,
        leafCount: 0,

      };

      for (const entity of domainEntities) {
        const entityNode: TreeNode = {
          id: `entity:${entity.entity_id}`,
          label: entity.name ?? entity.original_name ?? entity.entity_id,
          kind: "entity",
          domain,
          entityId: entity.entity_id,
          children: [],
          parent: domainNode,
          leafCount: 1,

        };
        domainNode.children.push(entityNode);
      }

      domainNode.leafCount = domainNode.children.length;
      areaNode.children.push(domainNode);
    }

    areaNode.leafCount = areaNode.children.reduce((sum, c) => sum + c.leafCount, 0);
    root.children.push(areaNode);
  }

  root.leafCount = root.children.reduce((sum, c) => sum + c.leafCount, 0);
  return root;
}

const NO_DEVICE = "No device";

export function buildTreeByDevice(registries: Registries): TreeNode {
  const { areas, devices, entities } = registries;

  const deviceMap = new Map<string, { name: string; areaId: string | null }>();
  for (const device of devices) {
    if (!device.disabled_by) {
      deviceMap.set(device.id, {
        name: device.name_by_user ?? device.name ?? device.id,
        areaId: device.area_id,
      });
    }
  }

  const areaNameMap = new Map<string, string>();
  for (const area of areas) {
    areaNameMap.set(area.area_id, area.name);
  }

  const grouped = new Map<string, Map<string, typeof entities>>();

  for (const entity of entities) {
    if (entity.disabled_by) continue;

    const deviceId = entity.device_id;
    const device = deviceId ? deviceMap.get(deviceId) : null;

    let areaId = entity.area_id ?? device?.areaId ?? null;
    const areaKey = areaId ?? UNASSIGNED_AREA;
    const deviceKey = deviceId ?? NO_DEVICE;

    if (!grouped.has(areaKey)) grouped.set(areaKey, new Map());
    const devMap = grouped.get(areaKey)!;
    if (!devMap.has(deviceKey)) devMap.set(deviceKey, []);
    devMap.get(deviceKey)!.push(entity);
  }

  const root: TreeNode = {
    id: "root",
    label: "Home",
    kind: "root",
    children: [],
    parent: null,
    leafCount: 0,

  };

  const sortedAreaKeys = [...grouped.keys()].sort((a, b) => {
    if (a === UNASSIGNED_AREA) return 1;
    if (b === UNASSIGNED_AREA) return -1;
    const nameA = areaNameMap.get(a) ?? a;
    const nameB = areaNameMap.get(b) ?? b;
    return nameA.localeCompare(nameB);
  });

  for (const areaKey of sortedAreaKeys) {
    const areaLabel =
      areaKey === UNASSIGNED_AREA ? UNASSIGNED_AREA : (areaNameMap.get(areaKey) ?? areaKey);

    const areaNode: TreeNode = {
      id: `area:${areaKey}`,
      label: areaLabel,
      kind: "area",
      children: [],
      parent: root,
      leafCount: 0,

    };

    const devMap = grouped.get(areaKey)!;
    const sortedDevices = [...devMap.keys()].sort((a, b) => {
      if (a === NO_DEVICE) return 1;
      if (b === NO_DEVICE) return -1;
      const nameA = deviceMap.get(a)?.name ?? a;
      const nameB = deviceMap.get(b)?.name ?? b;
      return nameA.localeCompare(nameB);
    });

    for (const deviceKey of sortedDevices) {
      const deviceEntities = devMap.get(deviceKey)!;
      const deviceInfo = deviceMap.get(deviceKey);
      const deviceLabel = deviceKey === NO_DEVICE ? NO_DEVICE : (deviceInfo?.name ?? deviceKey);

      const deviceNode: TreeNode = {
        id: `device:${areaKey}:${deviceKey}`,
        label: deviceLabel,
        kind: "device",
        children: [],
        parent: areaNode,
        leafCount: 0,

      };

      for (const entity of deviceEntities) {
        const domain = entity.entity_id.split(".")[0];
        const entityNode: TreeNode = {
          id: `entity:${entity.entity_id}`,
          label: entity.name ?? entity.original_name ?? entity.entity_id,
          kind: "entity",
          domain,
          entityId: entity.entity_id,
          children: [],
          parent: deviceNode,
          leafCount: 1,

        };
        deviceNode.children.push(entityNode);
      }

      deviceNode.leafCount = deviceNode.children.length;
      areaNode.children.push(deviceNode);
    }

    areaNode.leafCount = areaNode.children.reduce((sum, c) => sum + c.leafCount, 0);
    root.children.push(areaNode);
  }

  root.leafCount = root.children.reduce((sum, c) => sum + c.leafCount, 0);
  return root;
}

export function flattenTree(root: TreeNode): TreeNode[] {
  const nodes: TreeNode[] = [];
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    nodes.push(node);
    for (let i = node.children.length - 1; i >= 0; i--) {
      stack.push(node.children[i]);
    }
  }
  return nodes;
}

export function collectEdges(root: TreeNode): [TreeNode, TreeNode][] {
  const edges: [TreeNode, TreeNode][] = [];
  const stack: TreeNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const child of node.children) {
      edges.push([node, child]);
      stack.push(child);
    }
  }
  return edges;
}
