package cc.charin.api
{
   import flash.media.Sound;
   import flash.media.SoundChannel;
   import flash.media.SoundTransform;

   public class CharinAPI extends Sound
   {
      public var starts:int = 0;

      public var initialVolume:Number = -1;

      override public function play(startTime:Number = 0, loops:int = 0, transform:SoundTransform = null) : SoundChannel
      {
         this.starts += 1;
         this.initialVolume = transform == null ? 1 : transform.volume;
         return null;
      }
   }
}
