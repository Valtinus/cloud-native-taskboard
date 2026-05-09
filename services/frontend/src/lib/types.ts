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
  position: number
  created_at: string
}

export interface Task {
  id: number
  column_id: number
  title: string
  description: string | null
  assigned_user_id: number | null
  deadline: string | null
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
  completed: boolean
  position: number
  created_at: string
}
