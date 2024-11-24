document.addEventListener("alpine:init", () => {
  Alpine.data("state", () => ({
    // current state
    cstate: {
      time: null,
      messages: [],
      selectedModel: "llama-3.2-1b",
    },

    documents: [], // Store uploaded documents
    systemPrompt:
      "The user's name is Punarv. Always remember this context throughout the conversation.",

    // historical state
    histories: JSON.parse(localStorage.getItem("histories")) || [],

    home: 0,
    generating: false,
    endpoint: `http://localhost:52415/v1`,
    serverEndpoint: "http://localhost:8000",
    errorMessage: null,
    errorExpanded: false,
    errorTimeout: null,

    // performance tracking
    time_till_first: 0,
    tokens_per_second: 0,
    total_tokens: 0,

    // image handling
    imagePreview: null,

    // download progress
    downloadProgress: null,
    downloadProgressInterval: null,

    // Pending message storage
    pendingMessage: null,

    init() {
      localStorage.removeItem("pendingMessage");
      this.startDownloadProgressPolling();
    },

    removeHistory(cstate) {
      const index = this.histories.findIndex((state) => {
        return state.time === cstate.time;
      });
      if (index !== -1) {
        this.histories.splice(index, 1);
        localStorage.setItem("histories", JSON.stringify(this.histories));
      }
    },

    clearAllHistory() {
      this.histories = [];
      localStorage.setItem("histories", JSON.stringify([]));
    },

    formatBytes(bytes) {
      if (bytes === 0) return "0 B";
      const k = 1024;
      const sizes = ["B", "KB", "MB", "GB", "TB"];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
    },

    formatDuration(seconds) {
      if (seconds === null || seconds === undefined || isNaN(seconds))
        return "";
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      const s = Math.floor(seconds % 60);
      if (h > 0) return `${h}h ${m}m ${s}s`;
      if (m > 0) return `${m}m ${s}s`;
      return `${s}s`;
    },

    async populateSelector() {
      try {
        const response = await fetch(`${window.location.origin}/modelpool`);
        const responseText = await response.text();

        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }

        let responseJson;
        try {
          responseJson = JSON.parse(responseText);
        } catch (parseError) {
          console.error("Failed to parse JSON:", parseError);
          throw new Error(`Invalid JSON response: ${responseText}`);
        }

        const sel = document.querySelector(".model-select");
        if (!sel) {
          throw new Error("Could not find model selector element");
        }

        sel.innerHTML = "";

        const modelDict = responseJson["model pool"];
        if (!modelDict) {
          throw new Error("Response missing 'model pool' property");
        }

        Object.entries(modelDict).forEach(([key, value]) => {
          const opt = document.createElement("option");
          opt.value = key;
          opt.textContent = value;
          sel.appendChild(opt);
        });

        const firstKey = Object.keys(modelDict)[0];
        if (firstKey) {
          sel.value = firstKey;
          this.cstate.selectedModel = firstKey;
        }
      } catch (error) {
        console.error("Error populating model selector:", error);
        this.errorMessage = `Failed to load models: ${error.message}`;
      }
    },

    async handleImageUpload(event) {
      const file = event.target.files[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          this.imagePreview = e.target.result;
          this.imageUrl = e.target.result;
          this.cstate.messages.push({
            role: "user",
            content: `![Uploaded Image](${this.imagePreview})`,
          });
        };
        reader.readAsDataURL(file);
      }
    },

    async handleDocumentUpload(event) {
      const file = event.target.files[0];
      if (file) {
        try {
          const formData = new FormData();
          formData.append("file", file);

          // Send file to backend for processing
          const response = await fetch(`${this.serverEndpoint}/upload`, {
            method: "POST",
            body: formData,
          });

          if (!response.ok) {
            throw new Error(`Upload failed: ${response.statusText}`);
          }

          const result = await response.json();

          // Store document reference
          this.documents.push({
            name: file.name,
            id: result.document_id,
          });

          // Add confirmation message to chat
          this.cstate.messages.push({
            role: "system",
            content: `Added document: ${file.name} to the knowledge base. Document has been processed and indexed.`,
          });
        } catch (error) {
          console.error("Error uploading document:", error);
          this.cstate.messages.push({
            role: "system",
            content: `Error adding document: ${file.name}. ${error.message}`,
          });
        }
      }
    },

    async handleSend() {
      try {
        const el = document.getElementById("input-form");
        const value = el.value.trim();
        if (!value && !this.imagePreview) return;

        if (this.generating) return;
        this.generating = true;
        if (this.home === 0) this.home = 1;

        window.history.pushState({}, "", "/");

        if (value) {
          this.cstate.messages.push({ role: "user", content: value });
        }

        el.value = "";
        el.style.height = "auto";
        el.style.height = el.scrollHeight + "px";

        localStorage.setItem("pendingMessage", value);
        await this.processMessage(value);
      } catch (error) {
        console.error("error", error);
        const errorDetails = {
          message: error.message || "Unknown error",
          stack: error.stack,
          name: error.name || "Error",
        };

        this.errorMessage = {
          basic: `${errorDetails.name}: ${errorDetails.message}`,
          stack: errorDetails.stack,
        };

        if (this.errorTimeout) {
          clearTimeout(this.errorTimeout);
        }

        if (!this.errorExpanded) {
          this.errorTimeout = setTimeout(() => {
            this.errorMessage = null;
            this.errorExpanded = false;
          }, 30 * 1000);
        }
      } finally {
        this.generating = false;
      }
    },

    async processMessage(value) {
      try {
        const prefill_start = Date.now();
        let start_time = 0;
        let tokens = 0;
        this.tokens_per_second = 0;

        // Get augmented context from RAG if documents exist
        let augmentedContext = "";
        if (this.documents.length > 0) {
          try {
            const ragResponse = await fetch(
              `${this.serverEndpoint}/rag/query`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  query: value,
                  document_ids: this.documents.map((doc) => doc.id),
                }),
              }
            );

            if (!ragResponse.ok) {
              throw new Error(`RAG query failed: ${ragResponse.statusText}`);
            }

            const ragResult = await ragResponse.json();
            augmentedContext = ragResult.context;
          } catch (error) {
            console.error("Error getting RAG context:", error);
          }
        }

        // Prepare messages for API request
        let systemPrompt = this.systemPrompt;
        if (augmentedContext) {
          systemPrompt += `\n\nRelevant context for the current question:\n${augmentedContext}\n\nPlease use this context to help answer the user's questions.`;
        }

        let apiMessages = [
          {
            role: "system",
            content: systemPrompt,
          },
          ...this.cstate.messages,
        ];

        // Stream the response
        let gottenFirstChunk = false;
        for await (const chunk of this.openaiChatCompletion(
          this.cstate.selectedModel,
          apiMessages
        )) {
          if (!gottenFirstChunk) {
            this.cstate.messages.push({ role: "assistant", content: "" });
            gottenFirstChunk = true;
          }

          this.cstate.messages[this.cstate.messages.length - 1].content +=
            chunk;

          tokens += 1;
          this.total_tokens += 1;
          if (start_time === 0) {
            start_time = Date.now();
            this.time_till_first = start_time - prefill_start;
          } else {
            const diff = Date.now() - start_time;
            if (diff > 0) {
              this.tokens_per_second = tokens / (diff / 1000);
            }
          }
        }

        // Update history
        const cleanedCstate = JSON.parse(JSON.stringify(this.cstate));
        cleanedCstate.messages = cleanedCstate.messages.map((msg) => {
          if (Array.isArray(msg.content)) {
            return {
              ...msg,
              content: msg.content.map((item) =>
                item.type === "image_url"
                  ? {
                      type: "image_url",
                      image_url: { url: "[IMAGE_PLACEHOLDER]" },
                    }
                  : item
              ),
            };
          }
          return msg;
        });

        // Update the state in histories or add it if it doesn't exist
        const index = this.histories.findIndex(
          (cstate) => cstate.time === cleanedCstate.time
        );
        cleanedCstate.time = Date.now();
        if (index !== -1) {
          this.histories[index] = cleanedCstate;
        } else {
          this.histories.push(cleanedCstate);
        }

        localStorage.setItem("histories", JSON.stringify(this.histories));
      } catch (error) {
        console.error("Error:", error);
        this.errorMessage = `Error: ${error.message}`;
        throw error;
      }
    },

    async handleEnter(event) {
      if (!event.shiftKey) {
        event.preventDefault();
        await this.handleSend();
      }
    },

    updateTotalTokens(messages) {
      fetch(`${this.endpoint}/chat/token/encode`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages }),
      })
        .then((response) => response.json())
        .then((data) => {
          this.total_tokens = data.length;
        })
        .catch(console.error);
    },

    async *openaiChatCompletion(model, messages) {
      console.log("model", model);
      const response = await fetch(`${this.endpoint}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: model,
          messages: messages,
          stream: true,
        }),
      });

      if (!response.ok) {
        const errorResBody = await response.json();
        if (errorResBody?.detail) {
          throw new Error(
            `Failed to fetch completions: ${errorResBody.detail}`
          );
        } else {
          throw new Error("Failed to fetch completions: Unknown error");
        }
      }

      const reader = response.body
        .pipeThrough(new TextDecoderStream())
        .pipeThrough(new EventSourceParserStream())
        .getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value.type === "event") {
          const json = JSON.parse(value.data);
          if (json.choices) {
            const choice = json.choices[0];
            if (choice.finish_reason === "stop") break;
            yield choice.delta.content;
          }
        }
      }
    },

    async fetchDownloadProgress() {
      try {
        const response = await fetch(`${this.endpoint}/download/progress`);
        if (response.ok) {
          const data = await response.json();
          const progressArray = Object.values(data);
          if (progressArray.length > 0) {
            this.downloadProgress = progressArray.map((progress) => {
              if (progress.status === "complete") {
                return {
                  ...progress,
                  isComplete: true,
                  percentage: 100,
                };
              } else if (progress.status === "failed") {
                return {
                  ...progress,
                  isComplete: false,
                  errorMessage: "Download failed",
                };
              } else {
                return {
                  ...progress,
                  isComplete: false,
                  downloaded_bytes_display: this.formatBytes(
                    progress.downloaded_bytes
                  ),
                  total_bytes_display: this.formatBytes(progress.total_bytes),
                  overall_speed_display: progress.overall_speed
                    ? this.formatBytes(progress.overall_speed) + "/s"
                    : "",
                  overall_eta_display: progress.overall_eta
                    ? this.formatDuration(progress.overall_eta)
                    : "",
                  percentage: (
                    (progress.downloaded_bytes / progress.total_bytes) *
                    100
                  ).toFixed(2),
                };
              }
            });

            const allComplete = this.downloadProgress.every(
              (progress) => progress.isComplete
            );
            if (allComplete) {
              const savedMessage = localStorage.getItem("pendingMessage");
              if (savedMessage) {
                localStorage.removeItem("pendingMessage");
                if (this.lastErrorMessage) {
                  await this.processMessage(savedMessage);
                }
              }
              this.lastErrorMessage = null;
              this.downloadProgress = null;
            }
          } else {
            this.downloadProgress = null;
          }
        }
      } catch (error) {
        console.error("Error fetching download progress:", error);
        this.downloadProgress = null;
      }
    },

    startDownloadProgressPolling() {
      if (this.downloadProgressInterval) return;

      this.fetchDownloadProgress();
      this.downloadProgressInterval = setInterval(() => {
        this.fetchDownloadProgress();
      }, 1000);
    },
  }));
});

const { markedHighlight } = globalThis.markedHighlight;
marked.use(
  markedHighlight({
    langPrefix: "hljs language-",
    highlight(code, lang, _info) {
      const language = hljs.getLanguage(lang) ? lang : "plaintext";
      return hljs.highlight(code, { language }).value;
    },
  })
);

class EventSourceParserStream extends TransformStream {
  constructor() {
    let parser;

    super({
      start(controller) {
        parser = createParser((event) => {
          if (event.type === "event") {
            controller.enqueue(event);
          }
        });
      },

      transform(chunk) {
        parser.feed(chunk);
      },
    });
  }
}

function createParser(onParse) {
  let isFirstChunk;
  let buffer;
  let startingPosition;
  let startingFieldLength;
  let eventId;
  let eventName;
  let data;
  reset();
  return {
    feed,
    reset,
  };
  function reset() {
    isFirstChunk = true;
    buffer = "";
    startingPosition = 0;
    startingFieldLength = -1;
    eventId = void 0;
    eventName = void 0;
    data = "";
  }
  function feed(chunk) {
    buffer = buffer ? buffer + chunk : chunk;
    if (isFirstChunk && hasBom(buffer)) {
      buffer = buffer.slice(BOM.length);
    }
    isFirstChunk = false;
    const length = buffer.length;
    let position = 0;
    let discardTrailingNewline = false;
    while (position < length) {
      if (discardTrailingNewline) {
        if (buffer[position] === "\n") {
          ++position;
        }
        discardTrailingNewline = false;
      }
      let lineLength = -1;
      let fieldLength = startingFieldLength;
      let character;
      for (
        let index = startingPosition;
        lineLength < 0 && index < length;
        ++index
      ) {
        character = buffer[index];
        if (character === ":" && fieldLength < 0) {
          fieldLength = index - position;
        } else if (character === "\r") {
          discardTrailingNewline = true;
          lineLength = index - position;
        } else if (character === "\n") {
          lineLength = index - position;
        }
      }
      if (lineLength < 0) {
        startingPosition = length - position;
        startingFieldLength = fieldLength;
        break;
      } else {
        startingPosition = 0;
        startingFieldLength = -1;
      }
      parseEventStreamLine(buffer, position, fieldLength, lineLength);
      position += lineLength + 1;
    }
    if (position === length) {
      buffer = "";
    } else if (position > 0) {
      buffer = buffer.slice(position);
    }
  }
  function parseEventStreamLine(lineBuffer, index, fieldLength, lineLength) {
    if (lineLength === 0) {
      if (data.length > 0) {
        onParse({
          type: "event",
          id: eventId,
          event: eventName || void 0,
          data: data.slice(0, -1), // remove trailing newline
        });

        data = "";
        eventId = void 0;
      }
      eventName = void 0;
      return;
    }
    const noValue = fieldLength < 0;
    const field = lineBuffer.slice(
      index,
      index + (noValue ? lineLength : fieldLength)
    );
    let step = 0;
    if (noValue) {
      step = lineLength;
    } else if (lineBuffer[index + fieldLength + 1] === " ") {
      step = fieldLength + 2;
    } else {
      step = fieldLength + 1;
    }
    const position = index + step;
    const valueLength = lineLength - step;
    const value = lineBuffer.slice(position, position + valueLength).toString();
    if (field === "data") {
      data += value ? "".concat(value, "\n") : "\n";
    } else if (field === "event") {
      eventName = value;
    } else if (field === "id" && !value.includes("\0")) {
      eventId = value;
    } else if (field === "retry") {
      const retry = parseInt(value, 10);
      if (!Number.isNaN(retry)) {
        onParse({
          type: "reconnect-interval",
          value: retry,
        });
      }
    }
  }
}

const BOM = [239, 187, 191];
function hasBom(buffer) {
  return BOM.every((charCode, index) => buffer.charCodeAt(index) === charCode);
}
