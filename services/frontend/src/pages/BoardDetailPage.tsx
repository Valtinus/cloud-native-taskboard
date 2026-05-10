import { useEffect, useState, useCallback, Fragment } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import {
  DndContext, DragOverlay, PointerSensor, useSensor, useSensors,
  useDraggable, useDroppable,
  type DragStartEvent, type DragEndEvent,
} from '@dnd-kit/core'
import { CSS } from '@dnd-kit/utilities'
import { Plus, Trash2, ArrowLeft, ChevronLeft, ChevronRight, Calendar, Palette, CornerDownRight } from 'lucide-react'
import type { Column, Task, Subtask } from '@/lib/types'
import { PRIORITY_CONFIG, COLUMN_COLORS } from '@/lib/types'
import * as api from '@/lib/api'
import { cn, fmtDate } from '@/lib/utils'
import Navbar from '@/components/Navbar'
import TaskModal from '@/components/TaskModal'
import SubtaskModal from '@/components/SubtaskModal'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'

// ── types ─────────────────────────────────────────────────────────────────────

interface ColumnData extends Column {
  tasks: Task[]
  subtasks: Subtask[]
}

type DragItem =
  | { kind: 'task';    item: Task }
  | { kind: 'subtask'; item: Subtask }

type ModalState =
  | { kind: 'none' }
  | { kind: 'create';       columnId: number }
  | { kind: 'edit';         task: Task }
  | { kind: 'subtask-edit'; subtask: Subtask; parentTaskTitle: string }

// ── deadline coloring ─────────────────────────────────────────────────────────

interface DL { cardBorder: string; badgeBg: string; label: string }

function deadlineStyle(deadline: string | null): DL | null {
  if (!deadline) return null
  const days = (new Date(deadline.length === 10 ? deadline + 'T12:00:00Z' : deadline).getTime() - Date.now()) / 86_400_000
  if (days < 0)   return { cardBorder: 'border-red-400 dark:border-red-600 bg-red-50/60 dark:bg-red-950/20',   badgeBg: 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300',          label: 'Overdue' }
  if (days <= 7)  return { cardBorder: 'border-red-300 dark:border-red-600/70',                                  badgeBg: 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400',            label: '≤ 1 week' }
  if (days <= 30) return { cardBorder: 'border-orange-300 dark:border-orange-600/70',                            badgeBg: 'bg-orange-50 text-orange-600 dark:bg-orange-900/20 dark:text-orange-400', label: '≤ 1 month' }
  if (days <= 90) return { cardBorder: 'border-blue-300 dark:border-blue-600/70',                                badgeBg: 'bg-blue-50 text-blue-600 dark:bg-blue-900/20 dark:text-blue-400',         label: '≤ 3 months' }
  return            { cardBorder: 'border-green-300 dark:border-green-600/70',                                   badgeBg: 'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-400',    label: '' }
}

// ── shared card ───────────────────────────────────────────────────────────────

interface CardProps {
  title: string
  description: string | null
  priority: Task['priority']
  deadline: string | null
  parentLabel?: string
  subtaskCount?: number
  dimmed?: boolean
  onClick: () => void
}

function TaskCard({ title, description, priority, deadline, parentLabel, subtaskCount, dimmed, onClick }: CardProps) {
  const dl   = deadlineStyle(deadline)
  const pCfg = PRIORITY_CONFIG[priority] ?? PRIORITY_CONFIG.medium
  return (
    <div
      className={cn(
        'w-full cursor-pointer rounded-lg border bg-background/90 p-3 shadow-sm transition-all hover:-translate-y-0.5 hover:shadow-md',
        dl?.cardBorder ?? '',
        dimmed && 'opacity-40',
      )}
      onClick={onClick}
    >
      {parentLabel && (
        <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
          <CornerDownRight className="h-3 w-3 shrink-0" />
          <span className="truncate">{parentLabel}</span>
        </div>
      )}
      <p className="text-sm font-semibold leading-snug">{title}</p>
      {description && <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{description}</p>}
      <div className={cn('mt-2 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold', pCfg.badge)}>
        {pCfg.emoji} {pCfg.label}
      </div>
      {deadline && dl && (
        <div className={cn('mt-1.5 flex w-fit items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium', dl.badgeBg)}>
          <Calendar className="h-3 w-3" />
          {fmtDate(deadline)}
          {dl.label && <span className="opacity-75">· {dl.label}</span>}
        </div>
      )}
      {subtaskCount !== undefined && subtaskCount > 0 && (
        <p className="mt-1.5 text-xs text-muted-foreground">↳ {subtaskCount} subtask{subtaskCount !== 1 ? 's' : ''}</p>
      )}
    </div>
  )
}

// ── draggable wrapper ─────────────────────────────────────────────────────────

function Draggable({ dragId, data, children }: {
  dragId: string
  data: DragItem
  children: (isDragging: boolean) => React.ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: dragId, data })
  const style = transform ? { transform: CSS.Translate.toString(transform) } : undefined
  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners} className="touch-none">
      {children(isDragging)}
    </div>
  )
}

// ── droppable column ──────────────────────────────────────────────────────────

function DroppableArea({ columnId, children, className }: { columnId: number; children: React.ReactNode; className?: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col-${columnId}`, data: { columnId } })
  return (
    <div ref={setNodeRef} className={cn(className, isOver && 'ring-2 ring-inset ring-primary/40 rounded-b-xl')}>
      {children}
    </div>
  )
}

// ── main component ────────────────────────────────────────────────────────────

export default function BoardDetailPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const boardId  = Number(id)

  const [boardName, setBoardName]         = useState('')
  const [columns, setColumns]             = useState<ColumnData[]>([])
  const [loading, setLoading]             = useState(true)
  const [error, setError]                 = useState('')
  const [apiError, setApiError]           = useState('')
  const [modal, setModal]                 = useState<ModalState>({ kind: 'none' })
  const [colDialogOpen, setColDialogOpen] = useState(false)
  const [newColName, setNewColName]       = useState('')
  const [newColColor, setNewColColor]     = useState<string | null>(null)
  const [addingCol, setAddingCol]         = useState(false)
  const [activeItem, setActiveItem]       = useState<DragItem | null>(null)

  // Map of taskId -> Task for parent label lookups across all columns
  const [taskMap, setTaskMap] = useState<Map<number, Task>>(new Map())

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  // ── load ─────────────────────────────────────────────────────────────────────

  const loadBoard = useCallback(async () => {
    setLoading(true)
    try {
      const [boards, cols] = await Promise.all([api.listBoards(), api.listColumns(boardId)])
      const board = boards.find(b => b.id === boardId)
      if (!board) { navigate('/boards'); return }
      setBoardName(board.name)

      const colData: ColumnData[] = await Promise.all(
        cols.map(async col => {
          const [tasks, subtasks] = await Promise.all([
            api.listTasks(col.id),
            api.listSubtasksByColumn(col.id),
          ])
          return { ...col, tasks, subtasks }
        })
      )
      setColumns(colData)

      // Build global task map for parent-label resolution
      const map = new Map<number, Task>()
      colData.forEach(c => c.tasks.forEach(t => map.set(t.id, t)))
      setTaskMap(map)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }, [boardId, navigate])

  useEffect(() => { loadBoard() }, [loadBoard])

  // ── drag ──────────────────────────────────────────────────────────────────────

  function handleDragStart({ active }: DragStartEvent) {
    setActiveItem(active.data.current as DragItem)
  }

  async function handleDragEnd({ active, over }: DragEndEvent) {
    setActiveItem(null)
    if (!over) return
    const dragged = active.data.current as DragItem
    const newColId = (over.data.current as { columnId: number }).columnId
    if (!newColId) return

    if (dragged.kind === 'task') {
      const task = dragged.item
      if (task.column_id === newColId) return
      setColumns(prev => prev.map(c => {
        if (c.id === task.column_id) return { ...c, tasks: c.tasks.filter(t => t.id !== task.id) }
        if (c.id === newColId)       return { ...c, tasks: [...c.tasks, { ...task, column_id: newColId }] }
        return c
      }))
      try { await api.updateTask(task.id, { column_id: newColId }) }
      catch { setApiError('Failed to move task'); loadBoard() }

    } else {
      const st = dragged.item
      if (st.column_id === newColId) return
      setColumns(prev => prev.map(c => {
        if (c.id === st.column_id) return { ...c, subtasks: c.subtasks.filter(s => s.id !== st.id) }
        if (c.id === newColId)     return { ...c, subtasks: [...c.subtasks, { ...st, column_id: newColId }] }
        return c
      }))
      try { await api.updateSubtask(st.id, { column_id: newColId }) }
      catch { setApiError('Failed to move subtask'); loadBoard() }
    }
  }

  // ── column actions ─────────────────────────────────────────────────────────────

  async function addColumn(e: React.FormEvent) {
    e.preventDefault()
    if (!newColName.trim()) return
    setAddingCol(true); setApiError('')
    try {
      const col = await api.createColumn(boardId, newColName.trim(), newColColor)
      setColumns(prev => [...prev, { ...col, tasks: [], subtasks: [] }])
      setNewColName(''); setNewColColor(null); setColDialogOpen(false)
    } catch (e: unknown) { setApiError(e instanceof Error ? e.message : 'Failed') }
    finally { setAddingCol(false) }
  }

  async function deleteColumn(colId: number) {
    try { await api.deleteColumn(colId); setColumns(prev => prev.filter(c => c.id !== colId)) }
    catch (e: unknown) { setApiError(e instanceof Error ? e.message : 'Failed to delete') }
  }

  async function moveColumn(colId: number, direction: -1 | 1) {
    const idx = columns.findIndex(c => c.id === colId)
    const newPos = idx + direction
    if (newPos < 0 || newPos >= columns.length) return
    try {
      await api.updateColumn(colId, { position: newPos })
      const cols = await api.listColumns(boardId)
      setColumns(prev => cols.map(c => ({ ...c, tasks: prev.find(p => p.id === c.id)?.tasks ?? [], subtasks: prev.find(p => p.id === c.id)?.subtasks ?? [] })))
    } catch { setApiError('Failed to reorder') }
  }

  async function setColumnColor(colId: number, color: string | null) {
    try {
      const updated = await api.updateColumn(colId, color === null ? { clear_color: true } : { color })
      setColumns(prev => prev.map(c => c.id === colId ? { ...c, color: updated.color } : c))
    } catch { setApiError('Failed to update color') }
  }

  // ── task actions ───────────────────────────────────────────────────────────────

  function handleTaskCreated(task: Task) {
    setColumns(prev => prev.map(c => c.id === task.column_id ? { ...c, tasks: [...c.tasks, task] } : c))
    setTaskMap(prev => new Map(prev).set(task.id, task))
  }

  function handleTaskUpdated(updated: Task) {
    setColumns(prev => prev.map(c => {
      const had = c.tasks.some(t => t.id === updated.id)
      const willHave = c.id === updated.column_id
      if (had && !willHave) return { ...c, tasks: c.tasks.filter(t => t.id !== updated.id) }
      if (!had && willHave) return { ...c, tasks: [...c.tasks, updated] }
      return { ...c, tasks: c.tasks.map(t => t.id === updated.id ? updated : t) }
    }))
    setTaskMap(prev => new Map(prev).set(updated.id, updated))
    if (modal.kind === 'edit') setModal({ kind: 'edit', task: updated })
  }

  async function handleTaskDeleted(taskId: number) {
    await api.deleteTask(taskId)
    setColumns(prev => prev.map(c => ({ ...c, tasks: c.tasks.filter(t => t.id !== taskId) })))
    setTaskMap(prev => { const m = new Map(prev); m.delete(taskId); return m })
    setModal({ kind: 'none' })
  }

  // ── subtask actions ────────────────────────────────────────────────────────────

  function handleSubtaskUpdated(updated: Subtask) {
    setColumns(prev => prev.map(c => {
      const had = c.subtasks.some(s => s.id === updated.id)
      const willHave = c.id === updated.column_id
      if (had && !willHave) return { ...c, subtasks: c.subtasks.filter(s => s.id !== updated.id) }
      if (!had && willHave) return { ...c, subtasks: [...c.subtasks, updated] }
      return { ...c, subtasks: c.subtasks.map(s => s.id === updated.id ? updated : s) }
    }))
    if (modal.kind === 'subtask-edit') setModal({ ...modal, subtask: updated })
  }

  async function handleSubtaskDeleted(id: number) {
    await api.deleteSubtask(id)
    setColumns(prev => prev.map(c => ({ ...c, subtasks: c.subtasks.filter(s => s.id !== id) })))
    setModal({ kind: 'none' })
  }

  // ── render ──────────────────────────────────────────────────────────────────────

  if (loading) return <div className="min-h-screen"><Navbar /><p className="p-8 text-muted-foreground">Loading…</p></div>
  if (error)   return <div className="min-h-screen"><Navbar /><p className="p-8 text-destructive">{error}</p></div>

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <Navbar />

      <div className="flex items-center gap-3 border-b bg-gradient-to-r from-indigo-500/10 via-violet-500/5 to-transparent px-4 py-3 dark:from-indigo-900/20">
        <Button variant="ghost" size="icon" onClick={() => navigate('/boards')}>
          <ArrowLeft className="h-4 w-4" />
        </Button>
        <h1 className="text-lg font-semibold">{boardName}</h1>
        <div className="flex-1" />
        {apiError && <p className="max-w-xs truncate text-sm text-destructive">{apiError}</p>}
        <Button size="sm"
          className="bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700"
          onClick={() => setColDialogOpen(true)} disabled={columns.length >= 10}>
          <Plus className="mr-1 h-4 w-4" /> Column
        </Button>
      </div>

      <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
        <div className="flex flex-1 gap-4 overflow-x-auto p-4 pb-8">
          {columns.map((col, idx) => {
            const cStyle = COLUMN_COLORS.find(c => c.id === col.color) ?? COLUMN_COLORS[0]
            // Count subtasks of each task in this column for the badge
            const subtaskCountByTask = new Map<number, number>()
            columns.forEach(c => c.subtasks.forEach(st => {
              subtaskCountByTask.set(st.parent_task_id, (subtaskCountByTask.get(st.parent_task_id) ?? 0) + 1)
            }))

            return (
              <div key={col.id} className={cn('flex w-72 shrink-0 flex-col rounded-xl border shadow-sm', cStyle.wrapper || 'bg-muted/40')}>
                <div className={cn('flex items-center gap-1.5 rounded-t-xl px-3 py-2.5', cStyle.header || 'bg-muted/60')}>
                  <span className={cn('h-2.5 w-2.5 shrink-0 rounded-full', cStyle.dot || 'bg-slate-400')} />
                  <span className="flex-1 truncate text-sm font-semibold">{col.name}</span>
                  <Badge variant="secondary" className="text-xs">{col.tasks.length + col.subtasks.length}</Badge>

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-foreground">
                        <Palette className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-44 p-2">
                      <div className="grid grid-cols-5 gap-1.5">
                        {COLUMN_COLORS.map(c => (
                          <button key={String(c.id)} title={c.label} onClick={() => setColumnColor(col.id, c.id)}
                            className={cn('h-6 w-6 rounded-full border-2 transition-transform hover:scale-110', c.dot,
                              col.color === c.id ? 'border-foreground scale-110' : 'border-transparent')} />
                        ))}
                      </div>
                    </DropdownMenuContent>
                  </DropdownMenu>

                  <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" disabled={idx === 0} onClick={() => moveColumn(col.id, -1)}>
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground" disabled={idx === columns.length - 1} onClick={() => moveColumn(col.id, 1)}>
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                  <Button variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" disabled={columns.length <= 1} onClick={() => deleteColumn(col.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>

                <Separator />

                <DroppableArea columnId={col.id} className="flex flex-1 flex-col gap-2 overflow-y-auto p-2">
                  {/* Tasks */}
                  {col.tasks.map(task => (
                    <Fragment key={`task-${task.id}`}>
                      <Draggable dragId={`task-${task.id}`} data={{ kind: 'task', item: task }}>
                        {isDragging => (
                          <TaskCard
                            title={task.title}
                            description={task.description}
                            priority={task.priority}
                            deadline={task.deadline}
                            subtaskCount={subtaskCountByTask.get(task.id)}
                            dimmed={isDragging}
                            onClick={() => !isDragging && setModal({ kind: 'edit', task })}
                          />
                        )}
                      </Draggable>
                    </Fragment>
                  ))}

                  {/* Subtasks in this column — fully independent cards */}
                  {col.subtasks.map(st => {
                    const parentTitle = taskMap.get(st.parent_task_id)?.title ?? '…'
                    return (
                      <Draggable key={`subtask-${st.id}`} dragId={`subtask-${st.id}`} data={{ kind: 'subtask', item: st }}>
                        {isDragging => (
                          <TaskCard
                            title={st.title}
                            description={st.description}
                            priority={st.priority}
                            deadline={st.deadline}
                            parentLabel={parentTitle}
                            dimmed={isDragging}
                            onClick={() => !isDragging && setModal({ kind: 'subtask-edit', subtask: st, parentTaskTitle: parentTitle })}
                          />
                        )}
                      </Draggable>
                    )
                  })}
                </DroppableArea>

                <div className="p-2 pt-0">
                  <Button variant="ghost" size="sm" className="w-full justify-start text-muted-foreground hover:text-foreground"
                    onClick={() => setModal({ kind: 'create', columnId: col.id })}>
                    <Plus className="mr-1 h-4 w-4" /> Add task
                  </Button>
                </div>
              </div>
            )
          })}

          {columns.length === 0 && (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
              No columns yet. Add one to get started.
            </div>
          )}
        </div>

        <DragOverlay>
          {activeItem && (
            <div className="rotate-1 opacity-95 shadow-2xl w-72">
              <TaskCard
                title={activeItem.item.title}
                description={activeItem.item.description}
                priority={activeItem.item.priority}
                deadline={activeItem.item.deadline}
                parentLabel={activeItem.kind === 'subtask' ? (taskMap.get((activeItem.item as Subtask).parent_task_id)?.title ?? '…') : undefined}
                onClick={() => {}}
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>

      {/* Modals */}
      {modal.kind === 'create' && (
        <TaskModal mode="create" columnId={modal.columnId} open
          onClose={() => setModal({ kind: 'none' })}
          onCreated={t => { handleTaskCreated(t); setModal({ kind: 'none' }) }} />
      )}
      {modal.kind === 'edit' && (
        <TaskModal mode="edit" task={modal.task} open
          onClose={() => { setModal({ kind: 'none' }); loadBoard() }}
          onUpdated={handleTaskUpdated}
          onDeleted={handleTaskDeleted} />
      )}
      {modal.kind === 'subtask-edit' && (
        <SubtaskModal mode="edit" subtask={modal.subtask} parentTaskTitle={modal.parentTaskTitle}
          open onClose={() => setModal({ kind: 'none' })}
          onUpdated={handleSubtaskUpdated} onDeleted={handleSubtaskDeleted} />
      )}

      {/* Add column dialog */}
      <Dialog open={colDialogOpen} onOpenChange={setColDialogOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>Add column</DialogTitle></DialogHeader>
          <form onSubmit={addColumn} className="space-y-4">
            <Input placeholder="Column name" value={newColName} onChange={e => setNewColName(e.target.value)} maxLength={50} autoFocus />
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Color</p>
              <div className="flex flex-wrap gap-2">
                {COLUMN_COLORS.map(c => (
                  <button type="button" key={String(c.id)} title={c.label} onClick={() => setNewColColor(c.id)}
                    className={cn('h-7 w-7 rounded-full border-2 transition-transform hover:scale-110', c.dot,
                      newColColor === c.id ? 'border-foreground scale-110' : 'border-transparent')} />
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setColDialogOpen(false)}>Cancel</Button>
              <Button type="submit" disabled={addingCol || !newColName.trim()}
                className="bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700">
                {addingCol ? 'Adding…' : 'Add column'}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  )
}
