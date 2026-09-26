import type { Component } from 'vue';
import { Bot, ChartNoAxesCombined, Logs, Network, ShieldCheck } from '@lucide/vue';

export type AdminSection = 'overview' | 'agents' | 'models' | 'llm-calls' | 'audit-logs';

export interface AdminNavigationItem {
  id: AdminSection;
  label: string;
  path: string;
  icon: Component;
}

export interface AdminNavigationGroup {
  id: string;
  label: string;
  items: AdminNavigationItem[];
}

export const adminNavigationGroups: AdminNavigationGroup[] = [
  {
    id: 'overview',
    label: '',
    items: [
      {
        id: 'overview',
        label: '工作空间概览',
        path: '/admin/overview',
        icon: ChartNoAxesCombined,
      },
    ],
  },
  {
    id: 'capability',
    label: '能力',
    items: [
      { id: 'agents', label: 'Agent 管理', path: '/admin/agents', icon: Bot },
      { id: 'models', label: '模型管理', path: '/admin/models', icon: Network },
    ],
  },
  {
    id: 'runtime',
    label: '运行',
    items: [{ id: 'llm-calls', label: '调用流水', path: '/admin/llm-calls', icon: Logs }],
  },
  {
    id: 'security',
    label: '安全',
    items: [{ id: 'audit-logs', label: '审计日志', path: '/admin/audit-logs', icon: ShieldCheck }],
  },
];

export const adminNavigationItems = adminNavigationGroups.flatMap((group) => group.items);

export function adminSectionFromPath(path: string): AdminSection {
  const match = adminNavigationItems.find((item) => path.startsWith(item.path));
  return match?.id ?? 'overview';
}

export function adminSectionItem(section: AdminSection): AdminNavigationItem {
  return adminNavigationItems.find((item) => item.id === section) ?? adminNavigationItems[0]!;
}
