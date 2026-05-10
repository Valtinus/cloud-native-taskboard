export interface User {
  id: number
  name: string
  email: string
  created_at: string
}

export interface Board {
  id: number
  name: string
  owner_id: number
  created_at: string
}

export interface Column {
  id: number
  board_id: number
  name: string
  color: string | null
  position: number
  created_at: string
}

export type Priority = 'low' | 'medium' | 'high'

export interface Task {
  id: number
  column_id: number
  title: string
  description: string | null
  assigned_user_id: number | null
  deadline: string | null
  priority: Priority
  position: number
  created_at: string
}

export interface Subtask {
  id: number
  parent_task_id: number
  title: string
  description: string | null
  assigned_user_id: number | null
  deadline: string | null
  priority: Priority
  completed: boolean
  position: number
  created_at: string
}

export const PRIORITY_CONFIG: Record<Priority, { label: string; emoji: string; badge: string }> = {
  low:    { label: 'Low',    emoji: '📋', badge: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400' },
  medium: { label: 'Medium', emoji: '⚡', badge: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400' },
  high:   { label: 'High',   emoji: '🔥', badge: 'bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-400' },
}

export const COLUMN_COLORS: Array<{ id: string | null; label: string; dot: string; wrapper: string; header: string }> = [
  { id: null,     label: 'Default', dot: 'bg-slate-400',  wrapper: '',                                        header: '' },
  { id: 'red',    label: 'Red',     dot: 'bg-red-500',    wrapper: 'bg-red-50 dark:bg-red-950/20',            header: 'bg-red-100 dark:bg-red-900/30' },
  { id: 'orange', label: 'Orange',  dot: 'bg-orange-500', wrapper: 'bg-orange-50 dark:bg-orange-950/20',      header: 'bg-orange-100 dark:bg-orange-900/30' },
  { id: 'amber',  label: 'Amber',   dot: 'bg-amber-500',  wrapper: 'bg-amber-50 dark:bg-amber-950/20',        header: 'bg-amber-100 dark:bg-amber-900/30' },
  { id: 'green',  label: 'Green',   dot: 'bg-green-500',  wrapper: 'bg-green-50 dark:bg-green-950/20',        header: 'bg-green-100 dark:bg-green-900/30' },
  { id: 'teal',   label: 'Teal',    dot: 'bg-teal-500',   wrapper: 'bg-teal-50 dark:bg-teal-950/20',          header: 'bg-teal-100 dark:bg-teal-900/30' },
  { id: 'blue',   label: 'Blue',    dot: 'bg-blue-500',   wrapper: 'bg-blue-50 dark:bg-blue-950/20',          header: 'bg-blue-100 dark:bg-blue-900/30' },
  { id: 'violet', label: 'Violet',  dot: 'bg-violet-500', wrapper: 'bg-violet-50 dark:bg-violet-950/20',      header: 'bg-violet-100 dark:bg-violet-900/30' },
  { id: 'pink',   label: 'Pink',    dot: 'bg-pink-500',   wrapper: 'bg-pink-50 dark:bg-pink-950/20',          header: 'bg-pink-100 dark:bg-pink-900/30' },
]
