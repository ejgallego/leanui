module
public import LeanUIVir.Host
public section

namespace LeanUIVir.TestApp
open LeanUI

structure Model where
  stored : String := "pending"
  delayed : Nat := 0
  ticks : Nat := 0
  running : Bool := false
  order : String := ""
  bytes : String := "pending"
  image : String := "pending"
  fetched : String := "pending"

inductive Msg where
  | stored (value : Option String)
  | delayed | tick | toggle | focus | focused | key | url
  | read | readMissing | decode | download | fetch | delay | frame
  | readResult (result : Except String ByteArray)
  | decoded (result : Except String Bitmap)
  | fetched (result : Response)

def pixels : Bitmap := { width := 2, height := 1, data := ⟨#[255, 0, 0, 255, 0, 255, 0, 255]⟩ }

def update : Msg → Model → Model × Cmd Msg
  | .stored value, m => ({ m with stored := value.getD "absent" }, .none)
  | .delayed, m => ({ m with delayed := m.delayed + 1 }, .none)
  | .tick, m => ({ m with ticks := m.ticks + 1 }, .none)
  | .toggle, m => ({ m with running := !m.running }, .none)
  | .focus, m => ({ m with order := m.order ++ "event;" }, .focus "#probe-input")
  | .focused, m => ({ m with order := m.order ++ "focus;" }, .none)
  | .key, m => ({ m with order := m.order ++ "key;" }, .none)
  | .url, m => ({ m with order := m.order ++ "url;" }, .none)
  | .read, m => (m, .readFile 1 .readResult)
  | .readMissing, m => (m, .readFile 9999 .readResult)
  | .decode, m => (m, .decodeImage 2 .decoded)
  | .download, m => (m, .batch #[.drawBitmap "#pixels" pixels,
      .download "probe.bin" "application/octet-stream" pixels.data])
  | .fetch, m => (m, .fetch { url := "/slow" } .fetched)
  | .delay, m => (m, .after 60000 .delayed)
  | .frame, m => (m, .nextFrame (fun _ => .delayed))
  | .readResult (.ok b), m => ({ m with bytes := s!"{b.size}:{b[0]!}:{b[b.size - 1]!}" }, .none)
  | .readResult (.error e), m => ({ m with bytes := e }, .none)
  | .decoded (.ok img), m => ({ m with image := s!"{img.width}x{img.height}" }, .drawBitmap "#pixels" img)
  | .decoded (.error e), m => ({ m with image := e }, .none)
  | .fetched r, m => ({ m with fetched := r.body }, .none)

def output (name value : String) : Html Msg :=
  el "output" #[Attr.id name] #[text value]

def button (name : String) (msg : Msg) : Html Msg :=
  el "button" #[Attr.id name, Attr.onClick msg] #[text name]

def view (m : Model) : Html Msg :=
  el "div" #[] #[
    output "stored" m.stored, output "delayed" (toString m.delayed),
    output "ticks" (toString m.ticks), output "order" m.order,
    output "bytes" m.bytes, output "image" m.image, output "fetched" m.fetched,
    button "toggle" .toggle, button "focus" .focus, button "read" .read,
    button "read-missing" .readMissing, button "decode" .decode,
    button "download" .download, button "fetch" .fetch, button "delay" .delay, button "frame" .frame,
    el "input" #[Attr.id "probe-input", Attr.on "focus" { decode := fun _ => some .focused }] #[],
    el "canvas" #[Attr.id "pixels", Attr.attr "width" "2", Attr.attr "height" "1"] #[]]

def program : Program Model Msg := {
  init := fun flags => ({}, if flags == "fail" then
    .batch #[.after 60000 .delayed, .fetch { url := "/slow" } .fetched,
      .nextFrame (fun _ => .delayed), .pushUrl "http://["]
    else .batch #[.storageGet "leanui.vir.probe" .stored, .after 5 .delayed,
      .drawBitmap "#pixels" pixels])
  update, view
  subscriptions := fun m => .batch #[
    (if m.running then .every 10 .tick else .none),
    .keys (fun k => if k == "p" then some .key else none), .urlChanges (fun _ => .url)]
}

leanui_vir_app program

/-- Exercise a recoverable IO error without entering the app's state transition. -/
@[vir_export] def reject : IO Unit := throw (IO.userError "injected call failure")
end LeanUIVir.TestApp
