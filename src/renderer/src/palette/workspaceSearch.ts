import type { NoteDocument, Project, ProjectFolder, Ticket } from '../../../shared/types'
import { getFolderDisplayPath } from '../utils/projectFolders'
import type { PaletteItem } from './registry'

let notesOwner: string | null = null
let notes: NoteDocument[] = []
export function setPaletteNotes(owner: string | null, values: NoteDocument[]): void { notesOwner = owner; notes = values }
export function getPaletteNotes(owner: string | null): NoteDocument[] { return owner && owner === notesOwner ? notes : [] }

export function workspaceItems(data: { projects: Project[]; folders: ProjectFolder[]; tickets: Ticket[]; notes: NoteDocument[] }, actions: {
  project: (project: Project) => void
  folder: (folder: ProjectFolder) => void
  ticket: (ticket: Ticket) => void
  note: (note: NoteDocument) => void
}): PaletteItem[] {
  return [
    ...data.projects.filter(project => !project.inTrash).flatMap(project => [
      { id: `project:${project.id}`, group: 'Projects' as const, title: project.name, description: `${project.folderId ? getFolderDisplayPath(data.folders, project.folderId) + ' · ' : ''}${project.stagingUrl}`, keywords: `${project.adminUrl} ${project.figmaUrl || ''} ${project.googleSheetUrl || ''}`, run: () => actions.project(project) },
      ...(project.workspaceData?.annotations || []).map(annotation => ({ id: `annotation:${project.id}:${annotation.id}`, group: 'Annotations' as const, title: annotation.title || `Annotation ${annotation.badgeNumber}`, description: `${project.name} · ${annotation.notes.replace(/<[^>]*>/g, ' ')}`, keywords: annotation.elementPath, run: () => actions.project(project) })),
    ]),
    ...data.folders.map(folder => ({ id: `folder:${folder.id}`, group: 'Folders' as const, title: folder.name, description: getFolderDisplayPath(data.folders, folder.id), run: () => actions.folder(folder) })),
    ...data.tickets.map(ticket => ({ id: `ticket:${ticket.id}`, group: 'Tickets' as const, title: ticket.title, description: `${ticket.source.provider} · ${ticket.sourceGroup} · ${ticket.progress.qaStatus} · ${ticket.description}`, keywords: `${ticket.source.externalId} ${ticket.source.url || ''} ${ticket.sourceStatus} ${Object.values(ticket.resources).filter(value => typeof value === 'string').join(' ')}`, run: () => actions.ticket(ticket) })),
    ...data.notes.map(note => ({ id: `note:${note.id}`, group: 'Notes' as const, title: note.title || 'Untitled note', description: `${note.archived ? 'Archived · ' : ''}${note.plainText}`, keywords: `${note.tags.join(' ')} ${note.attachments.map(attachment => attachment.name).join(' ')}`, run: () => actions.note(note) })),
  ]
}
