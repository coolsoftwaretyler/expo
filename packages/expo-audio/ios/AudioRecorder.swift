import ExpoModulesCore

private let recordingStatus = "recordingStatusUpdate"

class AudioRecorder: SharedRef<AVAudioRecorder>, RecordingResultHandler {
  let id = UUID().uuidString
  private var recordingDelegate: RecordingDelegate?
  private var startTimestamp = 0
  private var previousRecordingDuration = 0
  private var isPrepared = false
  private var recordingSession = AVAudioSession.sharedInstance()
  var allowsRecording = true

  override init(_ ref: AVAudioRecorder) {
    super.init(ref)
    recordingDelegate = RecordingDelegate(resultHandler: self)
    ref.delegate = recordingDelegate
  }

  var isRecording: Bool {
    ref.isRecording
  }

  var currentTime: Double {
    ref.currentTime * 1000
  }

  var deviceCurrentTime: Int {
    Int(ref.deviceCurrentTime * 1000)
  }

  var uri: String {
    ref.url.absoluteString
  }

  private var currentDuration: Int {
    guard startTimestamp > 0 else {
      return 0
    }
    return deviceCurrentTime - startTimestamp
  }

  func prepare(options: RecordingOptions?) throws {
    do {
      try recordingSession.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
      try recordingSession.setActive(true)
    } catch {
      throw AudioRecordingException("Failed to configure audio session: \(error.localizedDescription)")
    }

    if let options {
      let newRef = AudioUtils.createRecorder(directory: recordingDirectory, with: options)
      ref = newRef
      ref.delegate = recordingDelegate
    }

    if let isMeteringEnabled = options?.isMeteringEnabled {
      ref.isMeteringEnabled = isMeteringEnabled
    }

    guard ref.prepareToRecord() else {
      throw AudioRecordingException("Failed to prepare recorder")
    }

    isPrepared = true
  }

  func startRecording() -> [String: Any] {
    if !allowsRecording {
      log.info("Recording is currently disabled")
      return [:]
    }
    ref.record()
    startTimestamp = Int(deviceCurrentTime)
    return getRecordingStatus()
  }

  func stopRecording() {
    ref.stop()
    startTimestamp = 0
    previousRecordingDuration = 0
    isPrepared = false
  }

  func pauseRecording() {
    ref.pause()
    previousRecordingDuration += currentDuration
    startTimestamp = 0
  }

  func getRecordingStatus() -> [String: Any] {
    let currentDuration = isRecording ? currentDuration : 0
    let duration = previousRecordingDuration + Int(currentDuration)

    var result: [String: Any] = [
      "canRecord": isPrepared,
      "isRecording": isRecording,
      "durationMillis": duration,
      "mediaServicesDidReset": false,
      "url": ref.url
    ]

    if ref.isMeteringEnabled {
      ref.updateMeters()
      let currentLevel = ref.averagePower(forChannel: 0)
      result["metering"] = currentLevel
    }

    return result
  }

  func didFinish(_ recorder: AVAudioRecorder, successfully flag: Bool) {
    emit(event: recordingStatus, arguments: [
      "id": id,
      "isFinished": true,
      "hasError": false,
      "error": nil,
      "url": recorder.url
    ])
  }

  func encodeErrorDidOccur(_ recorder: AVAudioRecorder, error: Error?) {
    emit(event: recordingStatus, arguments: [
      "id": id,
      "isFinished": true,
      "hasError": true,
      "error": error?.localizedDescription,
      "url": nil
    ])
  }

  private var recordingDirectory: URL? {
    guard let cachesDir = appContext?.fileSystem?.cachesDirectory, let directory = URL(string: cachesDir) else {
      return nil
    }
    return directory
  }

  override func sharedObjectWillRelease() {
    AudioComponentRegistry.shared.remove(self)

    if ref.isRecording {
      ref.stop()
    }

    ref.delegate = nil
    recordingDelegate = nil

    do {
      try recordingSession.setActive(false, options: [.notifyOthersOnDeactivation])
    } catch {
    }
  }
}
