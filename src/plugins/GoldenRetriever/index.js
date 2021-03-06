const Plugin = require('../../core/Plugin')
const ServiceWorkerStore = require('./ServiceWorkerStore')
const IndexedDBStore = require('./IndexedDBStore')
const MetaDataStore = require('./MetaDataStore')

/**
* The Golden Retriever plugin — restores selected files and resumes uploads
* after a closed tab or a browser crash!
*
* Uses localStorage, IndexedDB and ServiceWorker to do its magic, read more:
* https://uppy.io/blog/2017/07/golden-retriever/
*/
module.exports = class GoldenRetriever extends Plugin {
  constructor (uppy, opts) {
    super(uppy, opts)
    this.type = 'debugger'
    this.id = 'GoldenRetriever'
    this.title = 'Golden Retriever'

    const defaultOptions = {
      expires: 24 * 60 * 60 * 1000, // 24 hours
      serviceWorker: false
    }

    this.opts = Object.assign({}, defaultOptions, opts)

    this.MetaDataStore = new MetaDataStore({
      expires: this.opts.expires,
      storeName: uppy.getID()
    })
    this.ServiceWorkerStore = null
    if (this.opts.serviceWorker) {
      this.ServiceWorkerStore = new ServiceWorkerStore({ storeName: uppy.getID() })
    }
    this.IndexedDBStore = new IndexedDBStore(Object.assign(
      { expires: this.opts.expires },
      opts.indexedDB || {},
      { storeName: uppy.getID() }))

    this.saveFilesStateToLocalStorage = this.saveFilesStateToLocalStorage.bind(this)
    this.loadFilesStateFromLocalStorage = this.loadFilesStateFromLocalStorage.bind(this)
    this.loadFileBlobsFromServiceWorker = this.loadFileBlobsFromServiceWorker.bind(this)
    this.loadFileBlobsFromIndexedDB = this.loadFileBlobsFromIndexedDB.bind(this)
    this.onBlobsLoaded = this.onBlobsLoaded.bind(this)
  }

  loadFilesStateFromLocalStorage () {
    const savedState = this.MetaDataStore.load()

    if (savedState) {
      this.uppy.log('Recovered some state from Local Storage')
      this.uppy.setState(savedState)
    }
  }

  /**
   * Get file objects that are currently waiting: they've been selected,
   * but aren't yet being uploaded.
   */
  getWaitingFiles () {
    const waitingFiles = {}

    const allFiles = this.uppy.state.files
    Object.keys(allFiles).forEach((fileID) => {
      const file = this.uppy.getFile(fileID)
      if (!file.progress || !file.progress.uploadStarted) {
        waitingFiles[fileID] = file
      }
    })

    return waitingFiles
  }

  /**
   * Get file objects that are currently being uploaded. If a file has finished
   * uploading, but the other files in the same batch have not, the finished
   * file is also returned.
   */
  getUploadingFiles () {
    const uploadingFiles = {}

    const { currentUploads } = this.uppy.state
    if (currentUploads) {
      const uploadIDs = Object.keys(currentUploads)
      uploadIDs.forEach((uploadID) => {
        const filesInUpload = currentUploads[uploadID].fileIDs
        filesInUpload.forEach((fileID) => {
          uploadingFiles[fileID] = this.uppy.getFile(fileID)
        })
      })
    }

    return uploadingFiles
  }

  saveFilesStateToLocalStorage () {
    const filesToSave = Object.assign(
      this.getWaitingFiles(),
      this.getUploadingFiles()
    )

    this.MetaDataStore.save({
      currentUploads: this.uppy.state.currentUploads,
      files: filesToSave
    })
  }

  loadFileBlobsFromServiceWorker () {
    this.ServiceWorkerStore.list().then((blobs) => {
      const numberOfFilesRecovered = Object.keys(blobs).length
      const numberOfFilesTryingToRecover = Object.keys(this.uppy.state.files).length
      if (numberOfFilesRecovered === numberOfFilesTryingToRecover) {
        this.uppy.log(`Successfully recovered ${numberOfFilesRecovered} blobs from Service Worker!`)
        this.uppy.info(`Successfully recovered ${numberOfFilesRecovered} files`, 'success', 3000)
        this.onBlobsLoaded(blobs)
      } else {
        this.uppy.log('Failed to recover blobs from Service Worker, trying IndexedDB now...')
        this.loadFileBlobsFromIndexedDB()
      }
    })
  }

  loadFileBlobsFromIndexedDB () {
    this.IndexedDBStore.list().then((blobs) => {
      const numberOfFilesRecovered = Object.keys(blobs).length

      if (numberOfFilesRecovered > 0) {
        this.uppy.log(`Successfully recovered ${numberOfFilesRecovered} blobs from Indexed DB!`)
        this.uppy.info(`Successfully recovered ${numberOfFilesRecovered} files`, 'success', 3000)
        return this.onBlobsLoaded(blobs)
      }
      this.uppy.log('Couldn’t recover anything from IndexedDB :(')
    })
  }

  onBlobsLoaded (blobs) {
    const obsoleteBlobs = []
    const updatedFiles = Object.assign({}, this.uppy.state.files)
    Object.keys(blobs).forEach((fileID) => {
      const originalFile = this.uppy.getFile(fileID)
      if (!originalFile) {
        obsoleteBlobs.push(fileID)
        return
      }

      const cachedData = blobs[fileID]

      const updatedFileData = {
        data: cachedData,
        isRestored: true
      }
      const updatedFile = Object.assign({}, originalFile, updatedFileData)
      updatedFiles[fileID] = updatedFile

      this.uppy.generatePreview(updatedFile)
    })
    this.uppy.setState({
      files: updatedFiles
    })
    this.uppy.emit('restored')

    if (obsoleteBlobs.length) {
      this.deleteBlobs(obsoleteBlobs).then(() => {
        this.uppy.log(`[GoldenRetriever] cleaned up ${obsoleteBlobs.length} old files`)
      })
    }
  }

  deleteBlobs (fileIDs) {
    const promises = []
    fileIDs.forEach((id) => {
      if (this.ServiceWorkerStore) {
        promises.push(this.ServiceWorkerStore.delete(id))
      }
      if (this.IndexedDBStore) {
        promises.push(this.IndexedDBStore.delete(id))
      }
    })
    return Promise.all(promises)
  }

  install () {
    this.loadFilesStateFromLocalStorage()

    if (Object.keys(this.uppy.state.files).length > 0) {
      if (this.ServiceWorkerStore) {
        this.uppy.log('Attempting to load files from Service Worker...')
        this.loadFileBlobsFromServiceWorker()
      } else {
        this.uppy.log('Attempting to load files from Indexed DB...')
        this.loadFileBlobsFromIndexedDB()
      }
    }

    this.uppy.on('file-added', (file) => {
      if (file.isRemote) return

      if (this.ServiceWorkerStore) {
        this.ServiceWorkerStore.put(file).catch((err) => {
          this.uppy.log('Could not store file', 'error')
          this.uppy.log(err)
        })
      }

      this.IndexedDBStore.put(file).catch((err) => {
        this.uppy.log('Could not store file', 'error')
        this.uppy.log(err)
      })
    })

    this.uppy.on('file-removed', (fileID) => {
      if (this.ServiceWorkerStore) this.ServiceWorkerStore.delete(fileID)
      this.IndexedDBStore.delete(fileID)
    })

    this.uppy.on('complete', ({ successful }) => {
      const fileIDs = successful.map((file) => file.id)
      this.deleteBlobs(fileIDs).then(() => {
        this.uppy.log(`[GoldenRetriever] removed ${successful.length} files that finished uploading`)
      })
    })

    this.uppy.on('state-update', this.saveFilesStateToLocalStorage)

    this.uppy.on('restored', () => {
      // start all uploads again when file blobs are restored
      const { currentUploads } = this.uppy.getState()
      if (currentUploads) {
        Object.keys(currentUploads).forEach((uploadId) => {
          this.uppy.restore(uploadId, currentUploads[uploadId])
        })
      }
    })
  }
}
