import { useEffect, useState, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Plus, Trash2, ArrowLeft, Clock } from 'lucide-react'
import type { Column, Task } from '@/lib/types'
import * as api from '@/lib/api'
import Navbar from '@/components/Navbar'
import TaskModal from '@/components/TaskModal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'

interface ColumnWithTasks extends Column {
  tasks: Task[]
}

export default function BoardDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const boardId = Number(id)

  const [boardName, setBoardName] = useState('')
  const [columns, setColumns] = useState<ColumnWithTasks[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [selectedTask, setSelectedTask] = useState<Task | null>(null)

  // New column dialog
  const [colDialogOpen, setColDialogOpen] = useState(false)
  const [newColName, setNewColName] = useState('')
  const [addingCol, setAddingCol] = useState(false)

  // New task dialog
  const [taskDialogCol, setTaskDialogCol] = useState<number | null>(null)
  const [newTaskTitle, setNewTaskTitle] = useState('')
  const [addingTask, setAddingTask] = useState(false)

  const [apiError, setApiError] = useState('')

  const loadBoard = useCallback(async () => {
    setLoading(true)
    try {
      const [board, cols] = await Promise.all([
        api.listBoards().then(bs => bs.find(b => b.id === boardId)),
        api.listColumns(boardId),
      ])
      if (!board) { navigate('/boards'); return }
      setBoardName(board.name)

      const withTasks = await Promise.all(
        cols.map(async col => ({
          ...col,
          tasks: await api.listTasks(col.id),
        }))
      )
      setColumns(withTasks)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [boardId, navigate])

  useEffect(() => { loadBoard() }, [loadBoard])

  async function addColumn(e: React.FormEvent) {
    e.preventDefault()
    if (!newColName.trim()) return
    setAddingCol(true)
    setApiError('')
    try {
      const col = await api.createColumn(boardId, newColName.trim())
      setColumns(prev => [...prev, { ...col, tasks: [] }])
      setNewColName('')
      setColDialogOpen(false)
    } catch (e: unknown) {
      setApiError(e instanceof Error ? e.message : 'Failed to add column')
    } finally {
      setAddingCol(false)
    }
  }

  async function deleteColumn(colId: number) {
    setApiError('')
    try {
      await api.deleteColumn(colId)
      setColumns(prev => prev.filter(c => c.id !== colId))
    } catch (e: unknown) {
      setApiError(e instanceof Error ? e.message : 'Failed to delete column')
    }
  }

  async function addTask(e: React.FormEvent) {
    e.preventDefault()
    if (!newTaskTitle.trim() || taskDialogCol === null) return
    setAddingTask(true)
    setApiError('')
    try {
      const task = await api.createTask(taskDialogCol, { title: newTaskTitle.trim() })
      setColumns(prev =>
        prev.map(c => c.id === taskDialogCol ? { ...c, tasks: [...c.tasks, task] } : c)
      )
      setNewTaskTitle('')
      setTaskDialogCol(null)
    } catch (e: unknown) {
      setApiError(e instanceof Error ? e.message : 'Failed to add task')
    } finally {
      setAddingTask(false)
    }
  }

  function handleTaskUpdated(updated: Task) {
    setColumns(prev =>
      prev.map(c => ({ ...c, tasks: c.tasks.map(t => (t.id === updated.id ? updated : t)) }))
    )
    setSelectedTask(updated)
  }

  async function handleTaskDeleted(taskId: number) {
    await api.deleteTask(taskId)
    setColumns(prev =>
      prev.map(c => ({ ...c, tasks: c.tasks.filter(t => t.id !== taskId) }))
    )
  }

  if (loading) return <div className="min-h-screen bg-background"><Navbar /><p className="p-8 text-muted-foreground">Loading…</p></div>
  if (error) return <div className="min-h-screen bg-background"><Navbar /><p className="p-8 text-destructive">{error}</p></div>

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Navbar />
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Button variant="ghost" size="icon" onClick={() => navigate('/boards')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-lg font-semibold">{boardName}</h1>
        <div className="flex-1" />
        {apiError && <p className="text-sm text-destructive">{apiError}</p>}
        <Button size="sm" onClick={() => setColDialogOpen(true)} disabled={columns.length >= 10}>
          <Plus className="mr-1 h-4 w-4" />
          Column
        </Button>
      </div>

      {/* Kanban board */}
      <div className="flex flex-1 gap-4 overflow-x-auto p-4">
        {columns.map(col => (
          <div key={col.id} className="flex w-72 shrink-0 flex-col rounded-lg border bg-muted/40">
            {/* Column header */}
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="flex-1 font-medium text-sm truncate">{col.name}</span>
              <Badge variant="secondary" className="text-xs">{col.tasks.length}</Badge>
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6 text-muted-foreground hover:text-destructive"
                onClick={() => deleteColumn(col.id)}
                title="Delete column"
                disabled={columns.length <= 1}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </div>
            <Separator />

            {/* Tasks */}
            <div className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
              {col.tasks.map(task => {
                const overdue = task.deadline && new Date(task.deadline) < new Date()
                return (
                  <button
                    key={task.id}
                    className="w-full rounded-md border bg-background p-3 text-left shadow-sm transition-shadow hover:shadow-md focus:outline-none focus:ring-2 focus:ring-ring"
                    onClick={() => setSelectedTask(task)}
                  >
                    <p className="text-sm font-medium leading-snug">{task.title}</p>
                    {task.deadline && (
                      <div className={`mt-1.5 flex items-center gap-1 text-xs ${overdue ? 'text-destructive' : 'text-muted-foreground'}`}>
                        <Clock className="h-3 w-3" />
                        {new Date(task.deadline).toLocaleDateString()}
                      </div>
                    )}
                    {task.description && (
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{task.description}</p>
                    )}
                  </button>
                )
              })}
            </div>

            {/* Add task */}
            <div className="p-2 pt-0">
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-muted-foreground"
                onClick={() => { setTaskDialogCol(col.id); setNewTaskTitle('') }}
              >
                <Plus className="mr-1 h-4 w-4" />
                Add task
              </Button>
            </div>
          </div>
        ))}

        {columns.length === 0 && (
          <div className="flex flex-1 items-center justify-center text-muted-foreground">
            <p>No columns yet. Add one to get started.</p>
          </div>
        )}
      </div>

      {/* Task modal */}
      {selectedTask && (
        <TaskModal
          task={selectedTask}
          open={!!selectedTask}
          onClose={() => setSelectedTask(null)}
          onUpdated={handleTaskUpdated}
          onDeleted={async id => { await handleTaskDeleted(id); setSelectedTask(null) }}
        />
      )}

      {/* Add column dialog */}
      <Dialog open={colDialogOpen} onOpenChange={setColDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add column</DialogTitle></DialogHeader>
          <form onSubmit={addColumn} className="space-y-4">
            <Input
              placeholder="Column name"
              value={newColName}
              onChange={e => setNewColName(e.target.value)}
              maxLength={50}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setColDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={addingCol || !newColName.trim()}>
                {addingCol ? 'Adding…' : 'Add'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      {/* Add task dialog */}
      <Dialog open={taskDialogCol !== null} onOpenChange={open => !open && setTaskDialogCol(null)}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add task</DialogTitle></DialogHeader>
          <form onSubmit={addTask} className="space-y-4">
            <Input
              placeholder="Task title"
              value={newTaskTitle}
              onChange={e => setNewTaskTitle(e.target.value)}
              autoFocus
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setTaskDialogCol(null)}>Cancel</Button>
              <Button type="submit" disabled={addingTask || !newTaskTitle.trim()}>
                {addingTask ? 'Adding…' : 'Add'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
