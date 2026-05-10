import { useEffect, useState } from 'react'
import { Trash2, Plus, Calendar, Flag } from 'lucide-react'
import type { Task, Subtask, Priority } from '@/lib/types'
import { PRIORITY_CONFIG } from '@/lib/types'
import * as api from '@/lib/api'
import { fmtDate, cn } from '@/lib/utils'
import SubtaskModal from '@/components/SubtaskModal'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

interface CreateProps {
  mode: 'create'
  columnId: number
  onCreated: (t: Task) => void
}
interface EditProps {
  mode: 'edit'
  task: Task
  onUpdated: (t: Task) => void
  onDeleted: (id: number) => void
}

type Props = (CreateProps | EditProps) & { open: boolean; onClose: () => void }

const PRIORITIES: Priority[] = ['low', 'medium', 'high']

export default function TaskModal(props: Props) {
  const isEdit = props.mode === 'edit'
  const task   = isEdit ? props.task : null

  const [title, setTitle]             = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [deadline, setDeadline]       = useState(task?.deadline ? task.deadline.slice(0, 10) : '')
  const [priority, setPriority]       = useState<Priority>(task?.priority ?? 'medium')
  const [subtasks, setSubtasks]       = useState<Subtask[]>([])
  const [saving, setSaving]           = useState(false)
  const [error, setError]             = useState('')

  const [addingSubtask, setAddingSubtask]   = useState(false)
  const [editingSubtask, setEditingSubtask] = useState<Subtask | null>(null)

  useEffect(() => {
    if (!props.open) return
    setTitle(task?.title ?? '')
    setDescription(task?.description ?? '')
    setDeadline(task?.deadline ? task.deadline.slice(0, 10) : '')
    setPriority(task?.priority ?? 'medium')
    setError('')
    setAddingSubtask(false)
    setEditingSubtask(null)
    if (isEdit && task) {
      api.listSubtasks(task.id).then(setSubtasks).catch(() => setSubtasks([]))
    } else {
      setSubtasks([])
    }
  }, [props.open]) // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (!title.trim()) { setError('Title is required'); return }
    setSaving(true)
    setError('')
    try {
      if (isEdit && task) {
        const patch: Record<string, unknown> = { title: title.trim(), priority }
        if (description.trim()) patch.description = description.trim()
        else patch.clear_description = true
        if (deadline) patch.deadline = deadline + 'T00:00:00.000Z'
        else patch.clear_deadline = true
        const updated = await api.updateTask(task.id, patch)
        props.onUpdated(updated)
      } else if (!isEdit) {
        const created = await api.createTask(props.columnId, {
          title: title.trim(),
          priority,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(deadline ? { deadline: deadline + 'T00:00:00.000Z' } : {}),
        })
        props.onCreated(created)
        props.onClose()
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  async function deleteSubtask(id: number) {
    await api.deleteSubtask(id)
    setSubtasks(prev => prev.filter(s => s.id !== id))
  }

  const pCfg      = PRIORITY_CONFIG[priority]
  const isOverdue = task?.deadline && new Date(task.deadline) < new Date()

  return (
    <>
      <Dialog open={props.open} onOpenChange={v => !v && props.onClose()}>
        <DialogContent className="max-w-lg max-h-[92vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              {isEdit ? 'Edit task' : 'New task'}
              {isOverdue && <Badge variant="destructive" className="text-xs">Overdue</Badge>}
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>Title</Label>
              <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Task title…" autoFocus />
            </div>

            <div className="space-y-1.5">
              <Label>Description <span className="text-xs font-normal text-muted-foreground">(optional)</span></Label>
              <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Add a description…" rows={3} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5"><Flag className="h-3.5 w-3.5" /> Priority</Label>
                <Select value={priority} onValueChange={v => setPriority(v as Priority)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {PRIORITIES.map(p => (
                      <SelectItem key={p} value={p}>
                        <span className="flex items-center gap-1.5">{PRIORITY_CONFIG[p].emoji} {PRIORITY_CONFIG[p].label}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <div className={cn('inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold', pCfg.badge)}>
                  {pCfg.emoji} {pCfg.label}
                </div>
              </div>

              <div className="space-y-1.5">
                <Label className="flex items-center gap-1.5"><Calendar className="h-3.5 w-3.5" /> Deadline</Label>
                <Input type="date" value={deadline} onChange={e => setDeadline(e.target.value)} />
                {deadline && (
                  <p className={`text-xs ${isOverdue ? 'text-destructive' : 'text-muted-foreground'}`}>{fmtDate(deadline)}</p>
                )}
              </div>
            </div>

            {error && <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}

            <div className="flex gap-2">
              <Button onClick={save} disabled={saving || !title.trim()}
                className="flex-1 bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700">
                {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create task'}
              </Button>
              {isEdit && (
                <Button variant="destructive" size="icon"
                  onClick={() => { props.onDeleted(task!.id); props.onClose() }}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>

            {isEdit && (
              <>
                <Separator />
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <Label>Subtasks</Label>
                    {subtasks.length > 0 && (
                      <span className="text-xs text-muted-foreground">{subtasks.length} total</span>
                    )}
                  </div>

                  {subtasks.map(st => {
                    const sCfg = PRIORITY_CONFIG[st.priority] ?? PRIORITY_CONFIG.medium
                    return (
                      <div key={st.id} className="group flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50"
                        onClick={() => setEditingSubtask(st)}>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm leading-snug">{st.title}</p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-2">
                            <span className={cn('text-xs font-medium', sCfg.badge.split(' ').slice(0,2).join(' '))}>
                              {sCfg.emoji} {sCfg.label}
                            </span>
                            {st.deadline && <span className="text-xs text-muted-foreground">📅 {fmtDate(st.deadline)}</span>}
                          </div>
                        </div>
                        <Button variant="ghost" size="icon" className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
                          onClick={e => { e.stopPropagation(); deleteSubtask(st.id) }}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    )
                  })}

                  <Button variant="outline" size="sm" className="w-full" onClick={() => setAddingSubtask(true)}>
                    <Plus className="mr-1.5 h-4 w-4" /> New subtask
                  </Button>
                </div>
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {isEdit && addingSubtask && (
        <SubtaskModal mode="create" parentTaskId={task!.id} parentTaskTitle={task!.title}
          open={addingSubtask} onClose={() => setAddingSubtask(false)}
          onCreated={st => setSubtasks(prev => [...prev, st])} />
      )}
      {isEdit && editingSubtask && (
        <SubtaskModal mode="edit" subtask={editingSubtask} parentTaskTitle={task!.title}
          open={!!editingSubtask} onClose={() => setEditingSubtask(null)}
          onUpdated={st => setSubtasks(prev => prev.map(s => s.id === st.id ? st : s))}
          onDeleted={id => setSubtasks(prev => prev.filter(s => s.id !== id))} />
      )}
    </>
  )
}
