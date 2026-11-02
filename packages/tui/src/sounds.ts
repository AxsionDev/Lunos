/// <reference path="./audio.d.ts" />
// XCOD-311: every bundled sound, by its shared ID (@opencode-ai/ui/sounds), so the TUI offers the
// same choices as the desktop app. `type: "file"` embeds each in the compiled binary.

import alert01 from "@opencode-ai/ui/audio/alert-01.mp3" with { type: "file" }
import alert02 from "@opencode-ai/ui/audio/alert-02.mp3" with { type: "file" }
import alert03 from "@opencode-ai/ui/audio/alert-03.mp3" with { type: "file" }
import alert04 from "@opencode-ai/ui/audio/alert-04.mp3" with { type: "file" }
import alert05 from "@opencode-ai/ui/audio/alert-05.mp3" with { type: "file" }
import alert06 from "@opencode-ai/ui/audio/alert-06.mp3" with { type: "file" }
import alert07 from "@opencode-ai/ui/audio/alert-07.mp3" with { type: "file" }
import alert08 from "@opencode-ai/ui/audio/alert-08.mp3" with { type: "file" }
import alert09 from "@opencode-ai/ui/audio/alert-09.mp3" with { type: "file" }
import alert10 from "@opencode-ai/ui/audio/alert-10.mp3" with { type: "file" }
import bipBop01 from "@opencode-ai/ui/audio/bip-bop-01.mp3" with { type: "file" }
import bipBop02 from "@opencode-ai/ui/audio/bip-bop-02.mp3" with { type: "file" }
import bipBop03 from "@opencode-ai/ui/audio/bip-bop-03.mp3" with { type: "file" }
import bipBop04 from "@opencode-ai/ui/audio/bip-bop-04.mp3" with { type: "file" }
import bipBop05 from "@opencode-ai/ui/audio/bip-bop-05.mp3" with { type: "file" }
import bipBop06 from "@opencode-ai/ui/audio/bip-bop-06.mp3" with { type: "file" }
import bipBop07 from "@opencode-ai/ui/audio/bip-bop-07.mp3" with { type: "file" }
import bipBop08 from "@opencode-ai/ui/audio/bip-bop-08.mp3" with { type: "file" }
import bipBop09 from "@opencode-ai/ui/audio/bip-bop-09.mp3" with { type: "file" }
import bipBop10 from "@opencode-ai/ui/audio/bip-bop-10.mp3" with { type: "file" }
import staplebops01 from "@opencode-ai/ui/audio/staplebops-01.mp3" with { type: "file" }
import staplebops02 from "@opencode-ai/ui/audio/staplebops-02.mp3" with { type: "file" }
import staplebops03 from "@opencode-ai/ui/audio/staplebops-03.mp3" with { type: "file" }
import staplebops04 from "@opencode-ai/ui/audio/staplebops-04.mp3" with { type: "file" }
import staplebops05 from "@opencode-ai/ui/audio/staplebops-05.mp3" with { type: "file" }
import staplebops06 from "@opencode-ai/ui/audio/staplebops-06.mp3" with { type: "file" }
import staplebops07 from "@opencode-ai/ui/audio/staplebops-07.mp3" with { type: "file" }
import nope01 from "@opencode-ai/ui/audio/nope-01.mp3" with { type: "file" }
import nope02 from "@opencode-ai/ui/audio/nope-02.mp3" with { type: "file" }
import nope03 from "@opencode-ai/ui/audio/nope-03.mp3" with { type: "file" }
import nope04 from "@opencode-ai/ui/audio/nope-04.mp3" with { type: "file" }
import nope05 from "@opencode-ai/ui/audio/nope-05.mp3" with { type: "file" }
import nope06 from "@opencode-ai/ui/audio/nope-06.mp3" with { type: "file" }
import nope07 from "@opencode-ai/ui/audio/nope-07.mp3" with { type: "file" }
import nope08 from "@opencode-ai/ui/audio/nope-08.mp3" with { type: "file" }
import nope09 from "@opencode-ai/ui/audio/nope-09.mp3" with { type: "file" }
import nope10 from "@opencode-ai/ui/audio/nope-10.mp3" with { type: "file" }
import nope11 from "@opencode-ai/ui/audio/nope-11.mp3" with { type: "file" }
import nope12 from "@opencode-ai/ui/audio/nope-12.mp3" with { type: "file" }
import yup01 from "@opencode-ai/ui/audio/yup-01.mp3" with { type: "file" }
import yup02 from "@opencode-ai/ui/audio/yup-02.mp3" with { type: "file" }
import yup03 from "@opencode-ai/ui/audio/yup-03.mp3" with { type: "file" }
import yup04 from "@opencode-ai/ui/audio/yup-04.mp3" with { type: "file" }
import yup05 from "@opencode-ai/ui/audio/yup-05.mp3" with { type: "file" }
import yup06 from "@opencode-ai/ui/audio/yup-06.mp3" with { type: "file" }

/** The file each bundled sound ID plays. */
export const SOUND_FILES: Record<string, string> = {
  "alert-01": alert01,
  "alert-02": alert02,
  "alert-03": alert03,
  "alert-04": alert04,
  "alert-05": alert05,
  "alert-06": alert06,
  "alert-07": alert07,
  "alert-08": alert08,
  "alert-09": alert09,
  "alert-10": alert10,
  "bip-bop-01": bipBop01,
  "bip-bop-02": bipBop02,
  "bip-bop-03": bipBop03,
  "bip-bop-04": bipBop04,
  "bip-bop-05": bipBop05,
  "bip-bop-06": bipBop06,
  "bip-bop-07": bipBop07,
  "bip-bop-08": bipBop08,
  "bip-bop-09": bipBop09,
  "bip-bop-10": bipBop10,
  "staplebops-01": staplebops01,
  "staplebops-02": staplebops02,
  "staplebops-03": staplebops03,
  "staplebops-04": staplebops04,
  "staplebops-05": staplebops05,
  "staplebops-06": staplebops06,
  "staplebops-07": staplebops07,
  "nope-01": nope01,
  "nope-02": nope02,
  "nope-03": nope03,
  "nope-04": nope04,
  "nope-05": nope05,
  "nope-06": nope06,
  "nope-07": nope07,
  "nope-08": nope08,
  "nope-09": nope09,
  "nope-10": nope10,
  "nope-11": nope11,
  "nope-12": nope12,
  "yup-01": yup01,
  "yup-02": yup02,
  "yup-03": yup03,
  "yup-04": yup04,
  "yup-05": yup05,
  "yup-06": yup06,
}
