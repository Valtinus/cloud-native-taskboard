import type { Board, Column, Task, Subtask, Priority } from './types'

const BASE = '/api'

async function request(path: string, options: RequestInit = {}): Promise<Response> {
  const token = localStorage.getItem('token')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const res = await fetch(`${BASE}${path}`, { ...options, headers })

  if (res.status === 401) {
    localStorage.removeItem('token')
    localStorage.removeItem('user')
    window.location.href = '/login'
    throw new Error('Unauthorized')
  }
  return res
}

async function json<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await request(path, options)
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }))
    throw new Error(body.error ?? res.statusText)
  }
  return res.json()
}

// Auth
export const register = (name: string, email: string, password: string) =>
  json<{ id: number; name: string; email: string }>('/auth/register', {
    method: 'POST', body: JSON.stringify({ name, email, password }),
  })

export const login = (email: string, password: string) =>
  json<{ token: string; user: { id: number; name: string; email: string } }>('/auth/login', {
    method: 'POST', body: JSON.stringify({ email, password }),
  })

// Boards
export const listBoards = () => json<Board[]>('/boards')
export const createBoard = (name: string) => json<Board>('/boards', { method: 'POST', body: JSON.stringify({ name }) })
export const deleteBoard = (id: number) => request(`/boards/${id}`, { method: 'DELETE' })
export const updateBoard = (id: number, name: string) =>
  json<Board>(`/boards/${id}`, { method: 'PUT', body: JSON.stringify({ name }) })

// Columns
export const listColumns = (boardId: number) => json<Column[]>(`/boards/${boardId}/columns`)

export const createColumn = (boardId: number, name: string, color?: string | null) =>
  json<Column>(`/boards/${boardId}/columns`, {
    method: 'POST', body: JSON.stringify({ name, color: color ?? null }),
  })

export const updateColumn = (id: number, patch: { name?: string; color?: string | null; clear_color?: boolean; position?: number }) =>
  json<Column>(`/columns/${id}`, { method: 'PUT', body: JSON.stringify(patch) })

export const deleteColumn = (id: number) => request(`/columns/${id}`, { method: 'DELETE' })

// Tasks
export const listTasks = (columnId: number) => json<Task[]>(`/columns/${columnId}/tasks`)

export const createTask = (columnId: number, data: {
  title: string
  description?: string
  deadline?: string
  assigned_user_id?: number
  priority?: Priority
}) =>
  json<Task>(`/columns/${columnId}/tasks`, { method: 'POST', body: JSON.stringify(data) })

export const updateTask = (id: number, patch: object) =>
  json<Task>(`/tasks/${id}`, { method: 'PUT', body: JSON.stringify(patch) })

export const deleteTask = (id: number) => request(`/tasks/${id}`, { method: 'DELETE' })

// Subtasks
export const listSubtasks = (taskId: number) => json<Subtask[]>(`/tasks/${taskId}/subtasks`)

export const createSubtask = (taskId: number, data: {
  title: string
  description?: string
  deadline?: string
  priority?: Priority
  assigned_user_id?: number
}) =>
  json<Subtask>(`/tasks/${taskId}/subtasks`, { method: 'POST', body: JSON.stringify(data) })

export const updateSubtask = (id: number, patch: object) =>
  json<Subtask>(`/subtasks/${id}`, { method: 'PUT', body: JSON.stringify(patch) })

export const deleteSubtask = (id: number) => request(`/subtasks/${id}`, { method: 'DELETE' })
