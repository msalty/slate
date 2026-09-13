/**
 * The parts of the File System Access API TypeScript's DOM library does not
 * describe yet.
 *
 * `FileSystemDirectoryHandle` and friends are standard and typed (the async
 * iteration over a directory's entries comes from the `DOM.AsyncIterable` lib,
 * switched on in tsconfig.json for exactly that). These three are not:
 *
 *  - `showDirectoryPicker` is specified but still absent from lib.dom.
 *  - `queryPermission` / `requestPermission` are a Chromium extension to the
 *    handle interface, and the whole reason a connected folder can survive a
 *    reload: the handle is stored, and permission to use it is asked for again.
 *  - `FileSystemObserver` is newer than the rest and ships in fewer browsers,
 *    so it is declared optional on `globalThis` and always feature-detected.
 *
 * Declared here rather than pulled in as a dependency: it is thirty lines, and
 * a type package that goes stale is worse than one that is written down.
 */

interface FileSystemHandlePermissionDescriptor {
  mode?: 'read' | 'readwrite'
}

interface FileSystemHandle {
  queryPermission?(d?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
  requestPermission?(d?: FileSystemHandlePermissionDescriptor): Promise<PermissionState>
}

interface DirectoryPickerOptions {
  id?: string
  mode?: 'read' | 'readwrite'
  startIn?: FileSystemHandle | 'desktop' | 'documents' | 'downloads' | 'music' | 'pictures' | 'videos'
}

declare function showDirectoryPicker(o?: DirectoryPickerOptions): Promise<FileSystemDirectoryHandle>

interface FileSystemObserverRecord {
  type: 'appeared' | 'disappeared' | 'modified' | 'moved' | 'unknown' | 'errored'
  relativePathComponents: string[]
}

declare class FileSystemObserver {
  constructor(callback: (records: FileSystemObserverRecord[], observer: FileSystemObserver) => void)
  observe(handle: FileSystemHandle, options?: { recursive?: boolean }): Promise<void>
  disconnect(): void
}
