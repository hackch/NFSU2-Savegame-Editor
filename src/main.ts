import { EditorController } from './controller/editor-controller.js';
import { nfsuFileChange } from './controller/file-change.js';

angular
  .module('nfsu2Editor', [])
  .directive('nfsuFileChange', nfsuFileChange)
  .controller('EditorController', ['$scope', EditorController]);
