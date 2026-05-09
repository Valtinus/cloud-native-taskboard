import { useEffect, useState } from 'react'
import { Trash2, Plus } from 'lucide-react'
import type { Task, Subtask } from '@/lib/types'
import * as api from '@/lib/api'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

interface Props {
  task: Task
  open: boolean
  onClose: () => void
  onUpdated: (t: Task) => void
  onDeleted: (id: number) => void
}

export default function TaskModal({ task, open, onClose, onUpdated, onDeleted }: Props) {
  const [title, setTitle] = useState(task.title)
  const [description, setDescription] = useState(task.description ?? '')
  const [deadline, setDeadline] = useState(task.deadline ? task.deadline.slice(0, 16) : '')
  const [subtasks, setSubtasks] = useState<Subtask[]>([])
  const [newSubtaskTitle, setNewSubtaskTitle] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (open) {
      setTitle(task.title)
      setDescription(task.description ?? '')
      setDeadline(task.deadline ? task.deadline.slice(0, 16) : '')
      setError('')
      api.listSubtasks(task.id).then(setSubtasks).catch(() => setSubtasks([]))
    }
  }, [open, task])

  async function save() {
    setSaving(true)
    setError('')
    try {
      const patch: Record<string, unknown> = { title }
      if (description) patch.description = description
      else patch.clear_description = true
      if (deadline) patch.deadline = new Date(deadline).toISOString()
      else patch.clear_deadline = true
      const updated = await api.updateTask(task.id, patch)
      onUpdated(updated)
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
    const st = await api.createSubtask(task.id, { title: newSubtaskTitle.trim() })
    setSubtasks(prev => [...prev, st])
    setNewSubtaskTitle('')
  }

  async function removeSubtask(id: number) {
    await api.deleteSubtask(id)
    setSubtasks(prev => prev.filter(s => s.id !== id))
  }

  const isOverdue = task.deadline && new Date(task.deadline) < new Date()

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Task
            {isOverdue && <Badge variant="destructive">Overdue</Badge>}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1">
            <Label>Title</Label>
            <Input value={title} onChange={e => setTitle(e.target.value)} />
          </div>

          <div className="space-y-1">
            <Label>Description</Label>
            <Textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional description…"
              rows={3}
            />
          </div>

          <div className="space-y-1">
            <Label>Deadline</Label>
            <Input
              type="datetime-local"
              value={deadline}
              onChange={e => setDeadline(e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2">
            <Button onClick={save} disabled={saving || !title.trim()} className="flex-1">
              {saving ? 'Saving…' : 'Save'}
            </Button>
            <Button
              variant="destructive"
              size="icon"
              onClick={() => { onDeleted(task.id); onClose() }}
              aria-label="Delete task"
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>

          <Separator />

          <div className="space-y-2">
            <Label>Subtasks ({subtasks.filter(s => s.completed).length}/{subtasks.length})</Label>
            {subtasks.map(st => (
              <div key={st.id} className="flex items-center gap-2 group">
                <Checkbox
                  checked={st.completed}
                  onCheckedChange={() => toggleSubtask(st)}
                />
                <span className={`flex-1 text-sm ${st.completed ? 'line-through text-muted-foreground' : ''}`}>
                  {st.title}
                </span>
                {st.deadline && (
                  <Badge
                    variant={new Date(st.deadline) < new Date() ? 'destructive' : 'outline'}
                    className="text-xs"
                  >
                    {new Date(st.deadline).toLocaleDateString()}
                  </Badge>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100"
                  onClick={() => removeSubtask(st.id)}
                >
                  <Trash2 className="h-3 w-3" />
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Input
                placeholder="New subtask…"
                value={newSubtaskTitle}
                onChange={e => setNewSubtaskTitle(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && addSubtask()}
                className="h-8 text-sm"
              />
              <Button size="sm" variant="outline" onClick={addSubtask} disabled={!newSubtaskTitle.trim()}>
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
