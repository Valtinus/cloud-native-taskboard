import { useEffect, useState } from 'react'
import { Trash2, Plus, Calendar, User, Flag } from 'lucide-react'
import type { Task, Subtask, Priority } from '@/lib/types'
import { PRIORITY_CONFIG } from '@/lib/types'
import * as api from '@/lib/api'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
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
  const task = isEdit ? props.task : null

  const [title, setTitle] = useState(task?.title ?? '')
  const [description, setDescription] = useState(task?.description ?? '')
  const [deadline, setDeadline] = useState(task?.deadline ? task.deadline.slice(0, 16) : '')
  const [priority, setPriority] = useState<Priority>(task?.priority ?? 'medium')
  const [subtasks, setSubtasks] = useState<Subtask[]>([])
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!props.open) return
    setTitle(task?.title ?? '')
    setDescription(task?.description ?? '')
    setDeadline(task?.deadline ? task.deadline.slice(0, 16) : '')
    setPriority(task?.priority ?? 'medium')
    setError('')
    setNewSubtaskTitle('')
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
        if (deadline) patch.deadline = new Date(deadline).toISOString()
        else patch.clear_deadline = true
        const updated = await api.updateTask(task.id, patch)
        props.onUpdated(updated)
      } else if (!isEdit) {
        const created = await api.createTask(props.columnId, {
          title: title.trim(),
          priority,
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(deadline ? { deadline: new Date(deadline).toISOString() } : {}),
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

  async function toggleSubtask(st: Subtask) {
    const updated = await api.updateSubtask(st.id, { completed: !st.completed })
    setSubtasks(prev => prev.map(s => (s.id === st.id ? updated : s)))
  }

  async function addSubtask() {
    if (!newSubtaskTitle.trim()) return
    const st = await api.createSubtask(task!.id, { title: newSubtaskTitle.trim() })
    setSubtasks(prev => [...prev, st])
    setNewSubtaskTitle('')
  }

  async function removeSubtask(id: number) {
    await api.deleteSubtask(id)
    setSubtasks(prev => prev.filter(s => s.id !== id))
  }

  const isOverdue = task?.deadline && new Date(task.deadline) < new Date()
  const pCfg = PRIORITY_CONFIG[priority]

  return (
    <Dialog open={props.open} onOpenChange={v => !v && props.onClose()}>
      <DialogContent className="max-w-lg max-h-[92vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isEdit ? 'Edit task' : 'New task'}
            {isOverdue && <Badge variant="destructive" className="text-xs">Overdue</Badge>}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Title */}
          <div className="space-y-1.5">
            <Label>Title</Label>
            <Input
              value={title}
              onChange={e => setTitle(e.target.value)}
              placeholder="Task title…"
              autoFocus
            />
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <Label className="flex items-center gap-1.5">
              Description <span className="text-xs font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Add a description…"
              rows={3}
            />
          </div>

          {/* Priority + Deadline row */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <Flag className="h-3.5 w-3.5" /> Priority
              </Label>
              <Select value={priority} onValueChange={v => setPriority(v as Priority)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIORITIES.map(p => (
                    <SelectItem key={p} value={p}>
                      <span className="flex items-center gap-1.5">
                        <span>{PRIORITY_CONFIG[p].emoji}</span>
                        <span>{PRIORITY_CONFIG[p].label}</span>
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <div className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold ${pCfg.badge}`}>
                {pCfg.emoji} {pCfg.label}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1.5">
                <Calendar className="h-3.5 w-3.5" /> Deadline
              </Label>
              <Input
                type="datetime-local"
                value={deadline}
                onChange={e => setDeadline(e.target.value)}
              />
              {deadline && (
                <p className={`text-xs ${isOverdue ? 'text-destructive' : 'text-muted-foreground'}`}>
                  {new Date(deadline).toLocaleDateString()}
                </p>
              )}
            </div>
          </div>

          {/* Assigned user info (read-only for now) */}
          {isEdit && task?.assigned_user_id && (
            <div className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-sm">
              <User className="h-4 w-4 text-muted-foreground" />
              <span className="text-muted-foreground">Assigned to user #{task.assigned_user_id}</span>
            </div>
          )}

          {error && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>
          )}

          {/* Action buttons */}
          <div className="flex gap-2">
            <Button
              onClick={save}
              disabled={saving || !title.trim()}
              className="flex-1 bg-gradient-to-r from-indigo-500 to-violet-600 hover:from-indigo-600 hover:to-violet-700"
            >
              {saving ? 'Saving…' : isEdit ? 'Save changes' : 'Create task'}
            </Button>
            {isEdit && (
              <Button
                variant="destructive"
                size="icon"
                onClick={() => { props.onDeleted(task!.id); props.onClose() }}
                aria-label="Delete task"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* Subtasks — only in edit mode */}
          {isEdit && (
            <>
              <Separator />
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <Label>Subtasks</Label>
                  {subtasks.length > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {subtasks.filter(s => s.completed).length}/{subtasks.length} done
                    </span>
                  )}
                </div>

                {subtasks.length > 0 && (
                  <div className="space-y-1.5">
                    {/* Progress bar */}
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-indigo-500 to-violet-600 transition-all"
                        style={{ width: `${subtasks.length ? (subtasks.filter(s => s.completed).length / subtasks.length) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                )}

                {subtasks.map(st => (
                  <div key={st.id} className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50">
                    <Checkbox
                      checked={st.completed}
                      onCheckedChange={() => toggleSubtask(st)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <p className={`text-sm leading-snug ${st.completed ? 'line-through text-muted-foreground' : ''}`}>
                        {st.title}
                      </p>
                      {st.deadline && (
                        <p className={`mt-0.5 text-xs ${new Date(st.deadline) < new Date() ? 'text-destructive' : 'text-muted-foreground'}`}>
                          📅 {new Date(st.deadline).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 shrink-0 opacity-0 group-hover:opacity-100"
                      onClick={() => removeSubtask(st.id)}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}

                <div className="flex gap-2 pt-1">
                  <Input
                    placeholder="Add subtask…"
                    value={newSubtaskTitle}
                    onChange={e => setNewSubtaskTitle(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && addSubtask()}
                    className="h-8 text-sm"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={addSubtask}
                    disabled={!newSubtaskTitle.trim()}
                  >
                    <Plus className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
